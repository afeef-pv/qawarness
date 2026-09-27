import {
  LLMError,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
} from "../core/llm/provider";

export interface DeepSeekConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

export class DeepSeekProvider implements LLMProvider {
  readonly name = "deepseek";
  private readonly apiKey: string;
  private readonly model: string;
  private readonly endpoint: string;
  private readonly http: (input: string, init?: RequestInit) => Promise<Response>;

  constructor(config: DeepSeekConfig) {
    if (!config.apiKey?.trim()) {
      throw new LLMError("DEEPSEEK_API_KEY is required", "configuration", this.name);
    }
    this.apiKey = config.apiKey.trim();
    this.model = config.model?.trim() || "deepseek-flash";
    const baseUrl = config.baseUrl?.trim() || "https://api.deepseek.com";
    try {
      const url = new URL(baseUrl);
      if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
        throw new Error("HTTPS required");
      }
      if (url.username || url.password || url.search || url.hash) {
        throw new Error("Unexpected URL component");
      }
      this.endpoint = `${url.href.replace(/\/$/, "")}/chat/completions`;
    } catch {
      throw new LLMError("DEEPSEEK_BASE_URL must be an HTTPS URL (or local HTTP URL)", "configuration", this.name);
    }
    this.http = config.fetch ?? fetch;
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    if (!request.messages.length) {
      throw new LLMError("LLM request requires at least one message", "configuration", this.name);
    }

    let response: Response;
    try {
      response = await this.http(this.endpoint, {
        method: "POST",
        signal: request.signal,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          messages: request.messages.map((message) => message.role === "tool"
            ? { role: "tool", tool_call_id: message.toolCallId, content: message.content }
            : message.toolCalls
              ? { role: "assistant", content: message.content || null, tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) }
              : { role: message.role, content: message.content }),
          ...(request.tools ? { thinking: { type: "disabled" }, tools: request.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })), tool_choice: "required", parallel_tool_calls: false } : {}),
          ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
          ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
          ...(request.responseFormat === undefined ? {} : {
            response_format: { type: request.responseFormat.type === "json" ? "json_object" : "text" },
          }),
        }),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new LLMError(`DeepSeek request failed: ${this.redact(detail)}`, "provider", this.name);
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      if (!response.ok) {
        throw new LLMError(`DeepSeek API returned HTTP ${response.status}`, "provider", this.name, response.status);
      }
      throw new LLMError("DeepSeek returned invalid JSON", "malformed_response", this.name);
    }

    if (!response.ok) {
      const errorMessage = isObject(data) && isObject(data.error) && typeof data.error.message === "string"
        ? `: ${this.redact(data.error.message)}`
        : "";
      throw new LLMError(`DeepSeek API returned HTTP ${response.status}${errorMessage}`, "provider", this.name, response.status);
    }

    if (!isObject(data) || typeof data.model !== "string" || !data.model ||
        !Array.isArray(data.choices) || !isObject(data.choices[0])) {
      throw new LLMError("DeepSeek returned a malformed or empty response", "malformed_response", this.name);
    }

    const choice = data.choices[0];
    const message = choice.message;
    if (!isObject(message)) {
      throw new LLMError("DeepSeek returned a malformed or empty response", "malformed_response", this.name);
    }
    const calls = message.tool_calls;
    if (calls !== undefined && (!Array.isArray(calls) || calls.some((call) => !isObject(call) || typeof call.id !== "string" || !isObject(call.function) || typeof call.function.name !== "string" || typeof call.function.arguments !== "string"))) {
      throw new LLMError("DeepSeek returned malformed tool calls", "malformed_response", this.name);
    }
    if ((typeof message.content !== "string" || !message.content.trim()) && (!Array.isArray(calls) || !calls.length)) {
      throw new LLMError("DeepSeek returned a malformed or empty response", "malformed_response", this.name);
    }
    const usage = isObject(data.usage) ? data.usage : undefined;
    return {
      provider: this.name,
      model: data.model,
      text: typeof message.content === "string" ? message.content : "",
      ...(Array.isArray(calls) ? { toolCalls: calls.map((call) => {
        const tool = call as { id: string; function: { name: string; arguments: string } };
        let args: unknown;
        try { args = JSON.parse(tool.function.arguments); } catch { args = tool.function.arguments; }
        return { id: tool.id, name: tool.function.name, arguments: args };
      }) } : {}),
      ...(typeof choice.finish_reason === "string" ? { finishReason: choice.finish_reason } : {}),
      ...(usage ? { usage: {
        ...(typeof usage.prompt_tokens === "number" ? { inputTokens: usage.prompt_tokens } : {}),
        ...(typeof usage.completion_tokens === "number" ? { outputTokens: usage.completion_tokens } : {}),
        ...(typeof usage.total_tokens === "number" ? { totalTokens: usage.total_tokens } : {}),
      } } : {}),
    };
  }

  private redact(message: string): string {
    return message.replaceAll(this.apiKey, "[redacted]");
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
