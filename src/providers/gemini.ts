import type { ChatRequest, ProviderConfig, StreamChunk } from "../types.js";
import { StreamflowError } from "../errors.js";
import { parseSSE } from "../parse-sse.js";

function flattenText(content: ChatRequest["messages"][number]["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((p) => (p.type === "text" ? p.text : ""))
    .filter(Boolean)
    .join("\n");
}

/**
 * Gemini streaming via the Generative Language API (`alt=sse`).
 */
export async function* streamGemini(
  config: ProviderConfig,
  request: ChatRequest,
  model: string,
): AsyncGenerator<StreamChunk, void, unknown> {
  const fetchFn = config.fetch ?? globalThis.fetch;
  if (!fetchFn) {
    throw new StreamflowError("No fetch implementation available", {
      code: "NO_FETCH",
      provider: "gemini",
    });
  }

  const apiKey = config.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new StreamflowError(
      "Missing Gemini API key. Pass apiKey or set GEMINI_API_KEY.",
      { code: "MISSING_API_KEY", provider: "gemini" },
    );
  }

  const baseUrl = (
    config.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta"
  ).replace(/\/$/, "");

  const system = request.messages
    .filter((m) => m.role === "system")
    .map((m) => flattenText(m.content))
    .join("\n\n");

  const contents = request.messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: flattenText(m.content) }],
    }));

  const body: Record<string, unknown> = {
    contents,
    generationConfig: {
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.maxTokens !== undefined ? { maxOutputTokens: request.maxTokens } : {}),
      ...(request.responseFormat?.type === "json_object"
        ? { responseMimeType: "application/json" }
        : {}),
    },
  };
  if (system) {
    body.systemInstruction = { parts: [{ text: system }] };
  }

  const url = `${baseUrl}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;

  const response = await fetchFn(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      ...(config.headers ?? {}),
    },
    body: JSON.stringify(body),
    signal: request.signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new StreamflowError(`Gemini request failed with ${response.status}`, {
      status: response.status,
      body: text,
      provider: "gemini",
      code: "HTTP_ERROR",
    });
  }

  for await (const data of parseSSE(response.body, request.signal)) {
    let parsed: {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
        finishReason?: string;
      }>;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        totalTokenCount?: number;
      };
    };
    try {
      parsed = JSON.parse(data);
    } catch {
      continue;
    }

    const text =
      parsed.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    const finishReason = parsed.candidates?.[0]?.finishReason;
    const usage = parsed.usageMetadata
      ? {
          promptTokens: Number(parsed.usageMetadata.promptTokenCount ?? 0),
          completionTokens: Number(parsed.usageMetadata.candidatesTokenCount ?? 0),
          totalTokens: Number(parsed.usageMetadata.totalTokenCount ?? 0),
        }
      : undefined;

    if (text || finishReason || usage) {
      yield {
        text,
        ...(finishReason ? { finishReason } : {}),
        ...(usage ? { usage } : {}),
        raw: parsed,
      };
    }
  }
}
