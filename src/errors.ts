export class StreamflowError extends Error {
  readonly status?: number;
  readonly body?: string;
  readonly code?: string;
  readonly provider?: string;

  constructor(
    message: string,
    options: {
      status?: number;
      body?: string;
      code?: string;
      provider?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "StreamflowError";
    this.status = options.status;
    this.body = options.body;
    this.code = options.code;
    this.provider = options.provider;
  }
}

export class TimeoutError extends StreamflowError {
  constructor(timeoutMs: number, provider?: string) {
    super(`Request timed out after ${timeoutMs}ms`, {
      code: "TIMEOUT",
      provider,
    });
    this.name = "TimeoutError";
  }
}

export class AbortError extends StreamflowError {
  constructor(provider?: string) {
    super("Request was aborted", { code: "ABORTED", provider });
    this.name = "AbortError";
  }
}
