import type {
  ChatMessage,
  ChatRequest,
  ProviderConfig,
  StreamChunk,
} from "../types.js";
import { StreamflowError } from "../errors.js";
import { parseSSE } from "../parse-sse.js";

function splitSystem(messages: ChatMessage[]): {
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
} {
  const systemParts: string[] = [];
  const rest: Array<{ role: "user" | "assistant"; content: string }> = [];

  for (const message of messages) {
    if (message.role === "system") {
      systemParts.push(
        typeof message.content === "string"
          ? message.content
          : message.content.map((p) => (p.type === "text" ? p.text : "")).join(""),
      );
      continue;
    }
    if (message.role === "user" || message.role === "assistant") {
      const content =
        typeof message.content === "string"
          ? message.content
          : message.content
              .map((p) => (p.type === "text" ? p.text : "[image]"))
              .join("\n");
      rest.push({ role: message.role, content });
    }
  }

  return {
    ...(systemParts.length ? { system: systemParts.join("\n\n") } : {}),
    messages: rest,
  };
}

export async function* streamAnthropic(
  config: ProviderConfig,
  request: ChatRequest,
  model: string,
): AsyncGenerator<StreamChunk, void, unknown> {
  const fetchFn = config.fetch ?? globalThis.fetch;
  if (!fetchFn) {
    throw new StreamflowError("No fetch implementation available", {
      code: "NO_FETCH",
      provider: "anthropic",
    });
  }

  const apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new StreamflowError(
      "Missing Anthropic API key. Pass apiKey or set ANTHROPIC_API_KEY.",
      { code: "MISSING_API_KEY", provider: "anthropic" },
    );
  }

  const baseUrl = (config.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
  const { system, messages } = splitSystem(request.messages);

  const body: Record<string, unknown> = {
    model,
    max_tokens: request.maxTokens ?? 1024,
    stream: true,
    messages,
  };
  if (system) body.system = system;
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.tools) {
    body.tools = request.tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters ?? { type: "object", properties: {} },
    }));
  }

  const response = await fetchFn(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      accept: "text/event-stream",
      ...(config.headers ?? {}),
    },
    body: JSON.stringify(body),
    signal: request.signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new StreamflowError(`Anthropic request failed with ${response.status}`, {
      status: response.status,
      body: text,
      provider: "anthropic",
      code: "HTTP_ERROR",
    });
  }

  for await (const data of parseSSE(response.body, request.signal)) {
    let event: {
      type: string;
      delta?: { type?: string; text?: string; stop_reason?: string | null };
      usage?: { input_tokens?: number; output_tokens?: number };
      message?: { usage?: { input_tokens?: number; output_tokens?: number } };
    };
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }

    if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
      const text = event.delta.text ?? "";
      if (text) yield { text, raw: event };
      continue;
    }

    if (event.type === "message_delta") {
      const finishReason = event.delta?.stop_reason ?? null;
      const usage = event.usage
        ? {
            promptTokens: 0,
            completionTokens: Number(event.usage.output_tokens ?? 0),
            totalTokens: Number(event.usage.output_tokens ?? 0),
          }
        : undefined;
      yield {
        text: "",
        finishReason,
        ...(usage ? { usage } : {}),
        raw: event,
      };
    }

    if (event.type === "message_start" && event.message?.usage) {
      yield {
        text: "",
        usage: {
          promptTokens: Number(event.message.usage.input_tokens ?? 0),
          completionTokens: 0,
          totalTokens: Number(event.message.usage.input_tokens ?? 0),
        },
        raw: event,
      };
    }
  }
}
