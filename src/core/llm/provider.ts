export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: LLMToolCall[];
  toolCallId?: string;
}

export interface LLMTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LLMToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface LLMRequest {
  messages: LLMMessage[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: { type: "text" | "json" };
  tools?: LLMTool[];
}

export interface LLMResponse {
  provider: string;
  model: string;
  text: string;
  toolCalls?: LLMToolCall[];
  finishReason?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}

export interface LLMProvider {
  readonly name: string;
  generate(request: LLMRequest): Promise<LLMResponse>;
}

export class LLMError extends Error {
  constructor(
    message: string,
    readonly kind: "configuration" | "provider" | "malformed_response",
    readonly provider: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LLMError";
  }
}
