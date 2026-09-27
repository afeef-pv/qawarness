export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMRequest {
  messages: LLMMessage[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: { type: "text" | "json" };
}

export interface LLMResponse {
  provider: string;
  model: string;
  text: string;
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
