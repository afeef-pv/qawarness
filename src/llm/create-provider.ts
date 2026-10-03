import type { LLMProvider } from "../core/llm/provider";
import { DeepSeekProvider } from "../providers/deepseek";

export function createLLMProvider(): LLMProvider {
  return new DeepSeekProvider({
    apiKey: Bun.env.DEEPSEEK_API_KEY ?? "",
    model: Bun.env.DEEPSEEK_MODEL,
    baseUrl: Bun.env.DEEPSEEK_BASE_URL,
  });
}

// Overrides apply only to failure investigation, not execution or judge proof.
export function createInvestigationProvider(): LLMProvider {
  const number = (key: string, min: number, max: number) => {
    const raw = Bun.env[key]; if (raw === undefined) return undefined;
    const value = Number(raw); if (!raw.trim() || !Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid ${key}`);
    return value;
  };
  return new DeepSeekProvider({ apiKey: Bun.env.DEEPSEEK_API_KEY ?? "",
    model: Bun.env.QA_REVIEWER_MODEL ?? Bun.env.DEEPSEEK_MODEL, baseUrl: Bun.env.DEEPSEEK_BASE_URL,
    reasoning: (Bun.env.QA_REVIEWER_REASONING ?? "none") as "none" | "low" | "high" | "max",
    temperature: number("QA_REVIEWER_TEMPERATURE", 0, 2), maxTokens: number("QA_REVIEWER_MAX_TOKENS", 1, 393216) });
}
