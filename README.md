# streamflow-ai

Unified **TypeScript streaming SDK** for modern AI providers.

```bash
npm install streamflow-ai
```

## Providers

OpenAI · Azure OpenAI · Anthropic · Gemini · Ollama · Groq · DeepSeek · Mistral · OpenRouter

## Features

- Streaming responses
- Tool calling
- JSON mode
- Image content parts
- Retry + timeout + `AbortController`
- Middleware pipeline
- Event hooks
- Token usage + cost estimates
- Type-safe API
- Excellent error messages

## Quick start

```ts
import { Streamflow } from "streamflow-ai";

const ai = new Streamflow({
  provider: "openai",
  apiKey: process.env.OPENAI_API_KEY,
  model: "gpt-4o-mini",
});

// Stream tokens
for await (const chunk of ai.stream({
  messages: [{ role: "user", content: "Write a haiku about Node.js" }],
})) {
  process.stdout.write(chunk.text);
}

// Or collect the full reply
const result = await ai.chat({
  messages: [{ role: "user", content: "Hello" }],
});

console.log(result.text, result.usage, result.costUsd, result.latencyMs);
```

## Switch providers

```ts
new Streamflow({ provider: "anthropic", apiKey: process.env.ANTHROPIC_API_KEY, model: "claude-3-5-haiku-latest" });
new Streamflow({ provider: "gemini", apiKey: process.env.GEMINI_API_KEY, model: "gemini-2.0-flash" });
new Streamflow({ provider: "groq", apiKey: process.env.GROQ_API_KEY, model: "llama-3.1-8b-instant" });
new Streamflow({ provider: "ollama", model: "llama3.2", baseUrl: "http://127.0.0.1:11434/v1" });
new Streamflow({
  provider: "azure-openai",
  apiKey: process.env.AZURE_OPENAI_API_KEY,
  baseUrl: process.env.AZURE_OPENAI_ENDPOINT,
  azureDeployment: "gpt-4o-mini",
  model: "gpt-4o-mini",
});
```

## JSON mode

```ts
await ai.chat({
  messages: [{ role: "user", content: "Return {\"ok\":true}" }],
  responseFormat: { type: "json_object" },
});
```

## Images

```ts
await ai.chat({
  messages: [{
    role: "user",
    content: [
      { type: "text", text: "Describe this image" },
      { type: "image_url", url: "https://example.com/cat.png" },
    ],
  }],
});
```

## Tools

```ts
await ai.chat({
  messages: [{ role: "user", content: "What's the weather in Paris?" }],
  tools: [{
    type: "function",
    function: {
      name: "get_weather",
      description: "Get weather by city",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
  }],
});
```

## Retry, timeout, abort

```ts
const ai = new Streamflow({
  provider: "openai",
  apiKey: process.env.OPENAI_API_KEY,
  model: "gpt-4o-mini",
  retry: { retries: 3, minDelayMs: 200, maxDelayMs: 2000 },
  timeoutMs: 30_000,
});

const controller = new AbortController();
setTimeout(() => controller.abort(), 5_000);

await ai.chat({
  messages: [{ role: "user", content: "Hello" }],
  signal: controller.signal,
});
```

## Middleware & hooks

```ts
ai.use(async function* (req, next) {
  console.log("outgoing", req.messages.length);
  yield* next(req);
});

ai.on("chunk", ({ chunk }) => console.log(chunk.text));
ai.on("response", ({ result }) => console.log(result.usage));
ai.on("error", ({ error }) => console.error(error));
ai.on("retry", ({ attempt, delayMs }) => console.warn("retry", attempt, delayMs));
```

## Errors

```ts
import { StreamflowError, TimeoutError, AbortError } from "streamflow-ai";

try {
  await ai.chat({ messages: [{ role: "user", content: "Hi" }] });
} catch (err) {
  if (err instanceof TimeoutError) { /* ... */ }
  if (err instanceof AbortError) { /* ... */ }
  if (err instanceof StreamflowError) {
    console.error(err.status, err.code, err.body);
  }
}
```

## Env keys

| Provider | Env |
|----------|-----|
| OpenAI | `OPENAI_API_KEY` |
| Azure OpenAI | `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT` |
| Anthropic | `ANTHROPIC_API_KEY` |
| Gemini | `GEMINI_API_KEY` |
| Groq | `GROQ_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| Mistral | `MISTRAL_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Ollama | none (local) |

## Versioning

Semantic Versioning. See [CHANGELOG.md](./CHANGELOG.md).

## License

MIT
