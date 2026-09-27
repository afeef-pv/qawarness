import { createLLMProvider } from "./llm/create-provider";

const provider = createLLMProvider();
const response = await provider.generate({
  messages: [
    { role: "system", content: "You are a test endpoint. Respond concisely." },
    { role: "user", content: "Reply with exactly the word PONG." },
  ],
  maxTokens: 32,
});

if (response.provider !== provider.name || !response.model || !response.text.trim()) {
  throw new Error("LLM smoke returned an incomplete normalized response");
}

console.log({ provider: response.provider, model: response.model, text: response.text, finishReason: response.finishReason, usage: response.usage });
