import type { LLMProvider } from "../core/llm/provider";
import { DeepSeekProvider } from "../providers/deepseek";

export function createLLMProvider(): LLMProvider {
  return new DeepSeekProvider({
    apiKey: Bun.env.DEEPSEEK_API_KEY ?? "",
    model: Bun.env.DEEPSEEK_MODEL,
    baseUrl: Bun.env.DEEPSEEK_BASE_URL,
  });
}
