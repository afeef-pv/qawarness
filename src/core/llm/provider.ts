export type LLMContentPart =
  | { type: "text"; text: string }
  | { type: "image"; dataUrl: string; detail?: "low" | "high" | "original" | "auto" };

export type LLMMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | LLMContentPart[] }
  | { role: "assistant"; content: string; toolCalls?: LLMToolCall[] }
  | { role: "tool"; content: string; toolCallId: string };

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
  signal?: AbortSignal;
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
