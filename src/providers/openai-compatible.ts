import type {
  ChatMessage,
  ChatRequest,
  ContentPart,
  ProviderConfig,
  StreamChunk,
  ToolCall,
  TokenUsage,
} from "../types.js";
import { StreamflowError } from "../errors.js";
import { parseSSE } from "../parse-sse.js";

type CompatibleProvider =
  | "openai"
  | "azure-openai"
  | "ollama"
  | "groq"
  | "deepseek"
  | "mistral"
  | "openrouter";

const DEFAULT_BASE: Record<CompatibleProvider, string> = {
  openai: "https://api.openai.com/v1",
  "azure-openai": "",
  ollama: "http://127.0.0.1:11434/v1",
  groq: "https://api.groq.com/openai/v1",
  deepseek: "https://api.deepseek.com/v1",
  mistral: "https://api.mistral.ai/v1",
  openrouter: "https://openrouter.ai/api/v1",
};

const ENV_KEYS: Partial<Record<CompatibleProvider, string>> = {
  openai: "OPENAI_API_KEY",
  "azure-openai": "AZURE_OPENAI_API_KEY",
  groq: "GROQ_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  mistral: "MISTRAL_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

function contentToOpenAI(content: ChatMessage["content"]): unknown {
  if (typeof content === "string") return content;
  return content.map((part: ContentPart) => {
    if (part.type === "text") return { type: "text", text: part.text };
    return {
      type: "image_url",
      image_url: { url: part.url, detail: part.detail ?? "auto" },
    };
  });
}

function resolveBaseUrl(config: ProviderConfig): string {
  if (config.baseUrl) return config.baseUrl.replace(/\/$/, "");
  if (config.provider === "azure-openai") {
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT?.replace(/\/$/, "");
    if (!endpoint) {
      throw new StreamflowError(
        "Azure OpenAI requires baseUrl or AZURE_OPENAI_ENDPOINT",
        { code: "MISSING_BASE_URL", provider: "azure-openai" },
      );
    }
    return endpoint;
  }
  return DEFAULT_BASE[config.provider as CompatibleProvider];
}

function resolveApiKey(config: ProviderConfig): string | undefined {
  if (config.apiKey) return config.apiKey;
  if (config.provider === "ollama") return config.apiKey ?? "ollama";
  const envName = ENV_KEYS[config.provider as CompatibleProvider];
  return envName ? process.env[envName] : undefined;
}

function mergeUsage(raw: Record<string, unknown> | undefined): TokenUsage | undefined {
  if (!raw) return undefined;
  const promptTokens = Number(raw.prompt_tokens ?? 0);
  const completionTokens = Number(raw.completion_tokens ?? 0);
  const totalTokens = Number(raw.total_tokens ?? promptTokens + completionTokens);
  return { promptTokens, completionTokens, totalTokens };
}

function mergeToolCallDeltas(
  acc: Map<number, ToolCall>,
  deltas: Array<{ index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }> | undefined,
): void {
  if (!deltas) return;
  for (const delta of deltas) {
    const index = delta.index ?? 0;
    const existing = acc.get(index) ?? {
      id: "",
      type: "function" as const,
      function: { name: "", arguments: "" },
    };
    if (delta.id) existing.id = delta.id;
    if (delta.function?.name) existing.function.name += delta.function.name;
    if (delta.function?.arguments) existing.function.arguments += delta.function.arguments;
    acc.set(index, existing);
  }
}

export async function* streamOpenAICompatible(
  config: ProviderConfig,
  request: ChatRequest,
  model: string,
): AsyncGenerator<StreamChunk, void, unknown> {
  const provider = config.provider as CompatibleProvider;
  const fetchFn = config.fetch ?? globalThis.fetch;
  if (!fetchFn) {
    throw new StreamflowError("No fetch implementation available", {
      code: "NO_FETCH",
      provider,
    });
  }

  const apiKey = resolveApiKey(config);
  if (!apiKey && provider !== "ollama") {
    throw new StreamflowError(
      `Missing API key for ${provider}. Pass apiKey or set ${ENV_KEYS[provider]}.`,
      { code: "MISSING_API_KEY", provider },
    );
  }

  const baseUrl = resolveBaseUrl(config);
  const isAzure = provider === "azure-openai";
  const deployment = config.azureDeployment ?? model;
  const apiVersion = config.azureApiVersion ?? process.env.AZURE_OPENAI_API_VERSION ?? "2024-10-21";

  const url = isAzure
    ? `${baseUrl}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`
    : `${baseUrl}/chat/completions`;

  const body: Record<string, unknown> = {
    model: isAzure ? undefined : model,
    messages: request.messages.map((m) => ({
      role: m.role,
      content: contentToOpenAI(m.content),
      ...(m.name ? { name: m.name } : {}),
      ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
      ...(m.toolCalls ? { tool_calls: m.toolCalls } : {}),
    })),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (isAzure) delete body.model;
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
  if (request.tools) body.tools = request.tools;
  if (request.toolChoice) body.tool_choice = request.toolChoice;
  if (request.responseFormat) body.response_format = request.responseFormat;

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
    ...(config.headers ?? {}),
  };
  if (isAzure) headers["api-key"] = apiKey!;
  else if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const response = await fetchFn(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: request.signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new StreamflowError(`${provider} request failed with ${response.status}`, {
      status: response.status,
      body: text,
      provider,
      code: "HTTP_ERROR",
    });
  }

  const toolAcc = new Map<number, ToolCall>();

  for await (const data of parseSSE(response.body, request.signal)) {
    let parsed: {
      choices?: Array<{
        delta?: {
          content?: string | null;
          tool_calls?: Array<{
            index?: number;
            id?: string;
            type?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
        finish_reason?: string | null;
      }>;
      usage?: Record<string, unknown>;
    };
    try {
      parsed = JSON.parse(data);
    } catch {
      continue;
    }

    const choice = parsed.choices?.[0];
    mergeToolCallDeltas(toolAcc, choice?.delta?.tool_calls);

    const text = choice?.delta?.content ?? "";
    const finishReason = choice?.finish_reason ?? undefined;
    const usage = mergeUsage(parsed.usage);
    const toolCalls =
      finishReason && toolAcc.size > 0 ? [...toolAcc.values()] : undefined;

    if (text || toolCalls || finishReason !== undefined || usage) {
      yield {
        text,
        ...(toolCalls ? { toolCalls } : {}),
        ...(finishReason !== undefined ? { finishReason } : {}),
        ...(usage ? { usage } : {}),
        raw: parsed,
      };
    }
  }
}
