import { describe, expect, test } from "bun:test";

import { LLMError } from "../core/llm/provider";
import { DeepSeekProvider } from "./deepseek";

describe("DeepSeekProvider", () => {
  test("translates tool calls and tool results through the neutral contract", async () => {
    let payload: Record<string, unknown> | undefined;
    const provider = new DeepSeekProvider({ apiKey: "test-key", fetch: async (_url, init) => {
      payload = JSON.parse(String(init?.body));
      return Response.json({ model: "deepseek-flash", choices: [{ message: { content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "click", arguments: '{"target":{"by":"text","text":"Go"}}' } }] }, finish_reason: "tool_calls" }] });
    } });
    const response = await provider.generate({ messages: [{ role: "user", content: "go" }], tools: [{ name: "click", description: "Click", inputSchema: { type: "object" } }] });
    expect(payload?.thinking).toEqual({ type: "disabled" });
    expect(payload?.tool_choice).toBe("required");
    expect(response.toolCalls).toEqual([{ id: "call-1", name: "click", arguments: { target: { by: "text", text: "Go" } } }]);
    await provider.generate({ messages: [{ role: "assistant", content: "", toolCalls: response.toolCalls }, { role: "tool", toolCallId: "call-1", content: "ok" }], tools: [{ name: "click", description: "Click", inputSchema: { type: "object" } }] });
    expect(payload?.messages).toEqual([{ role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "click", arguments: '{"target":{"by":"text","text":"Go"}}' } }] }, { role: "tool", tool_call_id: "call-1", content: "ok" }]);
  });
  test("translates JSON mode and normalizes a successful response", async () => {
    let payload: Record<string, unknown> | undefined;
    let signal: AbortSignal | null | undefined;
    const controller = new AbortController();
    const provider = new DeepSeekProvider({
      apiKey: "test-key",
      fetch: (async (_url, init) => {
        payload = JSON.parse(String(init?.body));
        signal = init?.signal;
        return Response.json({
          model: "deepseek-flash",
          choices: [{ message: { content: "{\"ok\":true}" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 },
        });
      }),
    });

    const response = await provider.generate({
      messages: [{ role: "user", content: "Return JSON" }],
      maxTokens: 20,
      responseFormat: { type: "json" },
      signal: controller.signal,
    });

    expect(payload?.response_format).toEqual({ type: "json_object" });
    expect(payload?.max_tokens).toBe(20);
    expect(signal).toBe(controller.signal);
    expect(response).toEqual({
      provider: "deepseek",
      model: "deepseek-flash",
      text: '{"ok":true}',
      finishReason: "stop",
      usage: { inputTokens: 7, outputTokens: 4, totalTokens: 11 },
    });
  });

  test("sends a reviewer image as a user content part", async () => {
    let payload: Record<string, unknown> | undefined;
    const provider = new DeepSeekProvider({ apiKey: "test-key", fetch: async (_url, init) => {
      payload = JSON.parse(String(init?.body));
      return Response.json({ model: "deepseek-flash", choices: [{ message: { content: '{"status":"satisfied","reason":"Visible"}' } }] });
    } });
    await provider.generate({ messages: [{ role: "user", content: [
      { type: "text", text: "Check this state" },
      { type: "image", dataUrl: "data:image/png;base64,cG5n", detail: "original" },
    ] }] });
    expect(payload?.messages).toEqual([{ role: "user", content: [
      { type: "text", text: "Check this state" },
      { type: "image_url", image_url: { url: "data:image/png;base64,cG5n", detail: "original" } },
    ] }]);
  });

  test("surfaces HTTP errors with status and redacts the key", async () => {
    const provider = new DeepSeekProvider({
      apiKey: "test-secret",
      fetch: async () => Response.json({ error: { message: "bad test-secret" } }, { status: 401 }),
    });

    try {
      await provider.generate({ messages: [{ role: "user", content: "hello" }] });
      throw new Error("Expected the request to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(LLMError);
      expect((error as LLMError).kind).toBe("provider");
      expect((error as LLMError).status).toBe(401);
      expect((error as Error).message).toContain("[redacted]");
      expect((error as Error).message).not.toContain("test-secret");
    }
  });

  test("rejects an empty provider response", async () => {
    const provider = new DeepSeekProvider({
      apiKey: "test-key",
      fetch: async () => Response.json({ model: "deepseek-flash", choices: [{ message: { content: "" } }] }),
    });
    await expect(provider.generate({ messages: [{ role: "user", content: "hello" }] }))
      .rejects.toMatchObject({ kind: "malformed_response" });
  });
});

test("thinking tool requests replay adapter continuation with compatible tool choice", async () => {
  const bodies: any[] = [];
  const provider = new DeepSeekProvider({ apiKey: "secret-key", reasoning: "high", model: "deepseek-v4-pro", fetch: async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ model: "returned-model", choices: [{ message: { content: null, reasoning_content: "opaque continuation", tool_calls: [{ id: "one", function: { name: "read_steps", arguments: '{}' } }] } }] });
  } });
  const tools = [{ name: "read_steps", description: "Read", inputSchema: {} }];
  const response = await provider.generate({ messages: [{ role: "user", content: "Review" }], tools });
  await provider.generate({ messages: [{ role: "assistant", content: "", toolCalls: response.toolCalls, continuation: response.continuation }, { role: "tool", toolCallId: "one", content: "evidence" }], tools });
  expect(bodies[0].thinking).toEqual({ type: "enabled" });
  expect(bodies[0].tool_choice).toBe("auto");
  expect(bodies[0].reasoning_effort).toBe("high");
  expect(bodies[0].temperature).toBeUndefined();
  expect(bodies[1].messages[0].reasoning_content).toBe("opaque continuation");
  expect(JSON.stringify(provider.settings)).not.toContain("secret-key");
});
