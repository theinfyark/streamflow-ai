import { describe, it, expect } from "vitest";
import { Streamflow, StreamflowError, parseSSE, estimateCost } from "../src/index.js";

function sseBody(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function mockFetch(body: string, status = 200): typeof fetch {
  return async () =>
    new Response(status >= 400 ? body : sseBody(body), {
      status,
      headers: { "content-type": "text/event-stream" },
    });
}

describe("streamflow-ai", () => {
  it("streams OpenAI-compatible deltas and aggregates chat()", async () => {
    const body = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}',
      "",
      'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");

    const ai = new Streamflow({
      provider: "openai",
      apiKey: "test",
      model: "gpt-4o-mini",
      fetch: mockFetch(body),
      retry: false,
    });

    const chunks: string[] = [];
    for await (const chunk of ai.stream({
      messages: [{ role: "user", content: "Hi" }],
    })) {
      chunks.push(chunk.text);
    }
    expect(chunks.join("")).toBe("Hello");

    const result = await ai.chat({
      messages: [{ role: "user", content: "Hi" }],
    });
    // second call uses same mock once — need fresh fetch per call; recreate
    const ai2 = new Streamflow({
      provider: "groq",
      apiKey: "test",
      model: "llama-3.1-8b-instant",
      fetch: mockFetch(body),
      retry: false,
    });
    const collected = await ai2.chat({
      messages: [{ role: "user", content: "Hi" }],
    });
    expect(collected.text).toBe("Hello");
    expect(collected.usage?.totalTokens).toBe(5);
    expect(collected.finishReason).toBe("stop");
    expect(typeof collected.costUsd).toBe("number");
    expect(collected.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("supports Anthropic streaming events", async () => {
    const body = [
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}',
      "",
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
      "",
    ].join("\n");

    const ai = new Streamflow({
      provider: "anthropic",
      apiKey: "test",
      model: "claude-3-5-haiku-latest",
      fetch: mockFetch(body),
      retry: false,
    });

    const result = await ai.chat({
      messages: [
        { role: "system", content: "Be brief" },
        { role: "user", content: "Hello" },
      ],
    });
    expect(result.text).toBe("Hi");
    expect(result.finishReason).toBe("end_turn");
  });

  it("supports Gemini streaming events", async () => {
    const body = [
      'data: {"candidates":[{"content":{"parts":[{"text":"Yo"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1,"totalTokenCount":2}}',
      "",
    ].join("\n");

    const ai = new Streamflow({
      provider: "gemini",
      apiKey: "test",
      model: "gemini-2.0-flash",
      fetch: mockFetch(body),
      retry: false,
    });

    const result = await ai.chat({
      messages: [{ role: "user", content: "Hi" }],
    });
    expect(result.text).toBe("Yo");
    expect(result.usage?.totalTokens).toBe(2);
  });

  it("emits event hooks and supports middleware", async () => {
    const body = [
      'data: {"choices":[{"delta":{"content":"A"},"finish_reason":"stop"}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");

    const events: string[] = [];
    const ai = new Streamflow({
      provider: "openai",
      apiKey: "test",
      model: "gpt-4o-mini",
      fetch: mockFetch(body),
      retry: false,
      middleware: [
        async function* (req, next) {
          events.push("mw");
          yield* next(req);
        },
      ],
    });

    ai.on("request", () => {
      events.push("request");
    });
    ai.on("chunk", () => {
      events.push("chunk");
    });
    ai.on("response", () => {
      events.push("response");
    });

    await ai.chat({ messages: [{ role: "user", content: "x" }] });
    expect(events).toContain("request");
    expect(events).toContain("mw");
    expect(events).toContain("chunk");
    expect(events).toContain("response");
  });

  it("throws typed errors on HTTP failure", async () => {
    const ai = new Streamflow({
      provider: "openai",
      apiKey: "bad",
      model: "gpt-4o-mini",
      fetch: mockFetch("nope", 401),
      retry: false,
    });

    await expect(
      ai.chat({ messages: [{ role: "user", content: "x" }] }),
    ).rejects.toBeInstanceOf(StreamflowError);
  });

  it("requires api keys with clear messages", async () => {
    const prev = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const ai = new Streamflow({
        provider: "openai",
        model: "gpt-4o-mini",
        retry: false,
        fetch: async () => new Response(""),
      });
      await expect(
        ai.chat({ messages: [{ role: "user", content: "x" }] }),
      ).rejects.toThrow(/OPENAI_API_KEY/);
    } finally {
      if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
    }
  });

  it("parses SSE and estimates cost", async () => {
    const frames: string[] = [];
    for await (const f of parseSSE(
      sseBody('data: {"a":1}\n\ndata: [DONE]\n\n'),
    )) {
      frames.push(f);
    }
    expect(frames).toEqual(['{"a":1}']);

    const cost = estimateCost("openai", "gpt-4o-mini", {
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
      totalTokens: 2_000_000,
    });
    expect(cost).toBe(0.75);
  });

  it("supports JSON mode + image content parts in request body shape", async () => {
    let captured: string | undefined;
    const fetchMock: typeof fetch = async (_url, init) => {
      captured = String(init?.body ?? "");
      return new Response(
        sseBody(
          [
            'data: {"choices":[{"delta":{"content":"{}"},"finish_reason":"stop"}]}',
            "",
            "data: [DONE]",
            "",
          ].join("\n"),
        ),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };

    const ai = new Streamflow({
      provider: "openai",
      apiKey: "test",
      model: "gpt-4o-mini",
      fetch: fetchMock,
      retry: false,
    });

    await ai.chat({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe" },
            { type: "image_url", url: "https://example.com/a.png" },
          ],
        },
      ],
      responseFormat: { type: "json_object" },
    });

    expect(captured).toContain("json_object");
    expect(captured).toContain("image_url");
  });
});
