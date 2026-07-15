import type {
  ChatRequest,
  ChatResult,
  EventHandler,
  EventMap,
  EventName,
  Middleware,
  ProviderConfig,
  RetryOptions,
  StreamChunk,
  StreamflowOptions,
  TokenUsage,
  ToolCall,
} from "./types.js";
import { AbortError, StreamflowError, TimeoutError } from "./errors.js";
import { withRetryIterable } from "./retry.js";
import { estimateCost } from "./pricing.js";
import { streamOpenAICompatible } from "./providers/openai-compatible.js";
import { streamAnthropic } from "./providers/anthropic.js";
import { streamGemini } from "./providers/gemini.js";

const OPENAI_COMPATIBLE = new Set([
  "openai",
  "azure-openai",
  "ollama",
  "groq",
  "deepseek",
  "mistral",
  "openrouter",
]);

function mergeUsage(a?: TokenUsage, b?: TokenUsage): TokenUsage | undefined {
  if (!a && !b) return undefined;
  return {
    promptTokens: Math.max(a?.promptTokens ?? 0, b?.promptTokens ?? 0),
    completionTokens: Math.max(a?.completionTokens ?? 0, b?.completionTokens ?? 0),
    totalTokens: Math.max(a?.totalTokens ?? 0, b?.totalTokens ?? 0),
  };
}

function linkAbortSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const active = signals.filter(Boolean) as AbortSignal[];
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  for (const signal of active) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }
  return controller.signal;
}

/**
 * Unified streaming AI client.
 *
 * @example
 * ```ts
 * const ai = new Streamflow({ provider: "openai", apiKey: "..." });
 * for await (const chunk of ai.stream({ messages: [{ role: "user", content: "Hi" }] })) {
 *   process.stdout.write(chunk.text);
 * }
 * ```
 */
export class Streamflow {
  private readonly config: ProviderConfig;
  private readonly retry: false | RetryOptions;
  private readonly timeoutMs?: number;
  private readonly pricing: boolean;
  private middleware: Middleware[];
  private readonly listeners = new Map<EventName, Set<EventHandler<EventName>>>();

  constructor(options: StreamflowOptions) {
    const {
      retry = true,
      timeoutMs,
      pricing = true,
      middleware = [],
      ...config
    } = options;

    this.config = config;
    this.retry =
      retry === false ? false : retry === true ? { retries: 2 } : retry;
    this.timeoutMs = timeoutMs;
    this.pricing = pricing;
    this.middleware = [...middleware];
  }

  /** Subscribe to lifecycle events. */
  on<E extends EventName>(event: E, handler: EventHandler<E>): () => void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(handler as EventHandler<EventName>);
    this.listeners.set(event, set);
    return () => set.delete(handler as EventHandler<EventName>);
  }

  /** Add middleware (outermost last). */
  use(mw: Middleware): this {
    this.middleware.push(mw);
    return this;
  }

  private async emit<E extends EventName>(event: E, payload: EventMap[E]): Promise<void> {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const handler of set) {
      await handler(payload);
    }
  }

  private resolveModel(request: ChatRequest): string {
    const model = request.model ?? this.config.model;
    if (!model) {
      throw new StreamflowError("model is required (pass in request or client options)", {
        code: "MISSING_MODEL",
        provider: this.config.provider,
      });
    }
    return model;
  }

  private rawStream(request: ChatRequest): AsyncIterable<StreamChunk> {
    const model = this.resolveModel(request);
    const provider = this.config.provider;

    if (OPENAI_COMPATIBLE.has(provider)) {
      return streamOpenAICompatible(this.config, request, model);
    }
    if (provider === "anthropic") {
      return streamAnthropic(this.config, request, model);
    }
    if (provider === "gemini") {
      return streamGemini(this.config, request, model);
    }
    throw new StreamflowError(`Unsupported provider: ${provider}`, {
      code: "UNSUPPORTED_PROVIDER",
      provider,
    });
  }

  private compose(request: ChatRequest): AsyncIterable<StreamChunk> {
    let next: (req: ChatRequest) => AsyncIterable<StreamChunk> = (req) =>
      this.rawStream(req);

    for (let i = this.middleware.length - 1; i >= 0; i -= 1) {
      const mw = this.middleware[i]!;
      const inner = next;
      next = (req) => mw(req, inner);
    }
    return next(request);
  }

  /**
   * Stream chunks from the configured provider.
   */
  async *stream(request: ChatRequest): AsyncGenerator<StreamChunk, void, unknown> {
    const timeoutMs = request.timeoutMs ?? this.timeoutMs;
    const timeoutController = timeoutMs ? new AbortController() : undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (timeoutController && timeoutMs) {
      timer = setTimeout(() => timeoutController.abort(), timeoutMs);
    }

    const signal = linkAbortSignals(request.signal, timeoutController?.signal);
    const finalRequest: ChatRequest = { ...request, signal };

    await this.emit("request", {
      request: finalRequest,
      provider: this.config.provider,
    });

    const factory = () => this.compose(finalRequest);

    try {
      const iterable =
        this.retry === false
          ? factory()
          : withRetryIterable(factory, this.retry, async (attempt, delayMs, error) => {
              await this.emit("retry", { attempt, delayMs, error });
            });

      for await (const chunk of iterable) {
        if (signal?.aborted) {
          throw signal === request.signal
            ? new AbortError(this.config.provider)
            : new TimeoutError(timeoutMs ?? 0, this.config.provider);
        }
        await this.emit("chunk", { chunk });
        yield chunk;
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        const mapped =
          request.signal?.aborted
            ? new AbortError(this.config.provider)
            : new TimeoutError(timeoutMs ?? 0, this.config.provider);
        await this.emit("error", { error: mapped });
        throw mapped;
      }
      const error = err instanceof Error ? err : new Error(String(err));
      await this.emit("error", { error });
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Collect a full chat completion (streams under the hood).
   */
  async chat(request: ChatRequest): Promise<ChatResult> {
    const started = Date.now();
    const chunks: StreamChunk[] = [];
    let text = "";
    let finishReason: string | null | undefined;
    let usage: TokenUsage | undefined;
    const toolMap = new Map<string, ToolCall>();

    for await (const chunk of this.stream(request)) {
      chunks.push(chunk);
      text += chunk.text;
      if (chunk.finishReason !== undefined) finishReason = chunk.finishReason;
      usage = mergeUsage(usage, chunk.usage);
      if (chunk.toolCalls) {
        for (const call of chunk.toolCalls) {
          toolMap.set(call.id || call.function.name, call);
        }
      }
    }

    const model = this.resolveModel(request);
    const result: ChatResult = {
      text,
      toolCalls: [...toolMap.values()],
      finishReason,
      usage,
      costUsd: this.pricing
        ? estimateCost(this.config.provider, model, usage)
        : null,
      latencyMs: Date.now() - started,
      chunks,
    };

    await this.emit("response", { result });
    return result;
  }
}
