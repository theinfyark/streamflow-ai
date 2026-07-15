import type { ProviderName, TokenUsage } from "./types.js";

/** Approximate USD per 1M tokens. Estimates only. */
export const PRICING: Record<string, Record<string, { input: number; output: number }>> = {
  openai: {
    "gpt-4o": { input: 2.5, output: 10 },
    "gpt-4o-mini": { input: 0.15, output: 0.6 },
    "gpt-4.1": { input: 2, output: 8 },
    "gpt-4.1-mini": { input: 0.4, output: 1.6 },
    default: { input: 0.5, output: 1.5 },
  },
  "azure-openai": {
    "gpt-4o": { input: 2.5, output: 10 },
    "gpt-4o-mini": { input: 0.15, output: 0.6 },
    default: { input: 0.5, output: 1.5 },
  },
  anthropic: {
    "claude-3-5-haiku-latest": { input: 0.8, output: 4 },
    "claude-3-5-sonnet-latest": { input: 3, output: 15 },
    "claude-sonnet-4-20250514": { input: 3, output: 15 },
    default: { input: 3, output: 15 },
  },
  gemini: {
    "gemini-2.0-flash": { input: 0.1, output: 0.4 },
    "gemini-2.5-flash": { input: 0.15, output: 0.6 },
    "gemini-1.5-pro": { input: 1.25, output: 5 },
    default: { input: 0.15, output: 0.6 },
  },
  groq: {
    "llama-3.3-70b-versatile": { input: 0.59, output: 0.79 },
    "llama-3.1-8b-instant": { input: 0.05, output: 0.08 },
    default: { input: 0.1, output: 0.1 },
  },
  deepseek: {
    "deepseek-chat": { input: 0.27, output: 1.1 },
    default: { input: 0.27, output: 1.1 },
  },
  mistral: {
    "mistral-small-latest": { input: 0.1, output: 0.3 },
    "mistral-large-latest": { input: 2, output: 6 },
    default: { input: 0.5, output: 1.5 },
  },
  openrouter: {
    default: { input: 0.5, output: 1.5 },
  },
  ollama: {
    default: { input: 0, output: 0 },
  },
};

export function estimateCost(
  provider: ProviderName,
  model: string,
  usage?: TokenUsage | null,
): number | null {
  if (!usage) return null;
  const table = PRICING[provider] ?? PRICING.openai!;
  const rates =
    table[model] ??
    Object.entries(table).find(
      ([k]) => k !== "default" && (model.includes(k) || k.includes(model)),
    )?.[1] ??
    table.default!;

  const cost =
    (usage.promptTokens / 1_000_000) * rates.input +
    (usage.completionTokens / 1_000_000) * rates.output;
  return Number(cost.toFixed(8));
}
