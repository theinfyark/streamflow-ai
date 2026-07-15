/** Supported providers. */
export type ProviderName =
  | "openai"
  | "azure-openai"
  | "anthropic"
  | "gemini"
  | "ollama"
  | "groq"
  | "deepseek"
  | "mistral"
  | "openrouter";

export type Role = "system" | "user" | "assistant" | "tool";

export type TextPart = { type: "text"; text: string };
export type ImagePart = {
  type: "image_url";
  url: string;
  detail?: "auto" | "low" | "high";
};

export type ContentPart = TextPart | ImagePart;
export type MessageContent = string | ContentPart[];

export interface ChatMessage {
  role: Role;
  content: MessageContent;
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface StreamChunk {
  text: string;
  toolCalls?: ToolCall[];
  finishReason?: string | null;
  usage?: TokenUsage;
  raw?: unknown;
}

export interface ChatResult {
  text: string;
  toolCalls: ToolCall[];
  finishReason?: string | null;
  usage?: TokenUsage;
  costUsd?: number | null;
  latencyMs: number;
  chunks: StreamChunk[];
}

export type ResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | {
      type: "json_schema";
      json_schema: {
        name: string;
        schema: Record<string, unknown>;
        strict?: boolean;
      };
    };

export interface ChatRequest {
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  tools?: ToolDefinition[];
  toolChoice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  responseFormat?: ResponseFormat;
  signal?: AbortSignal;
  timeoutMs?: number;
  metadata?: Record<string, unknown>;
}

export interface ProviderConfig {
  provider: ProviderName;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /** Azure OpenAI deployment / resource helpers */
  azureDeployment?: string;
  azureApiVersion?: string;
  headers?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
}

export type EventMap = {
  request: { request: ChatRequest; provider: ProviderName };
  chunk: { chunk: StreamChunk };
  response: { result: ChatResult };
  error: { error: Error };
  retry: { attempt: number; delayMs: number; error: Error };
};

export type EventName = keyof EventMap;
export type EventHandler<E extends EventName> = (payload: EventMap[E]) => void | Promise<void>;

export type Middleware = (
  request: ChatRequest,
  next: (request: ChatRequest) => AsyncIterable<StreamChunk>,
) => AsyncIterable<StreamChunk>;

export interface RetryOptions {
  retries?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
}

export interface StreamflowOptions extends ProviderConfig {
  retry?: boolean | RetryOptions;
  timeoutMs?: number;
  pricing?: boolean;
  middleware?: Middleware[];
}
