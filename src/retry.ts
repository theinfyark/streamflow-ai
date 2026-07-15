import type { RetryOptions } from "./types.js";

const TRANSIENT = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
]);

function isTransient(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; status?: number; name?: string };
  if (e.name === "TimeoutError") return true;
  if (e.status && [408, 429, 500, 502, 503, 504].includes(e.status)) return true;
  if (e.code && TRANSIENT.has(e.code)) return true;
  return false;
}

export async function* withRetryIterable<T>(
  factory: () => AsyncIterable<T>,
  options: RetryOptions = {},
  onRetry?: (attempt: number, delayMs: number, error: Error) => void | Promise<void>,
): AsyncGenerator<T, void, unknown> {
  const retries = options.retries ?? 2;
  const minDelayMs = options.minDelayMs ?? 200;
  const maxDelayMs = options.maxDelayMs ?? 2000;
  const factor = options.factor ?? 2;

  let attempt = 0;
  let delay = minDelayMs;

  while (true) {
    try {
      yield* factory();
      return;
    } catch (err) {
      attempt += 1;
      const error = err instanceof Error ? err : new Error(String(err));
      if (attempt > retries || !isTransient(err)) throw error;
      const wait = Math.min(delay, maxDelayMs);
      await onRetry?.(attempt, wait, error);
      await new Promise((r) => setTimeout(r, wait));
      delay *= factor;
    }
  }
}
