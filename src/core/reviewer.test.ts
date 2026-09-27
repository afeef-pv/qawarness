import { expect, test } from "bun:test";
import type { LLMProvider } from "./llm/provider";
import { reviewJudgeProof } from "./reviewer";

const proof = { type: "judge" as const, text: "The account is active" };
const observation = { platform: "web" as const, location: { url: "http://localhost/account" }, text: "Account active", elements: [], errors: [] };

for (const status of ["satisfied", "not_satisfied", "inconclusive"] as const) {
  test(`reviewer ${status} result controls proof pass`, async () => {
    const provider: LLMProvider = { name: "fake", async generate(request) {
      expect(request.responseFormat).toEqual({ type: "json" });
      return { provider: "fake", model: "reviewer", text: JSON.stringify({ status, reason: "Evidence checked" }) };
    } };
    const result = await reviewJudgeProof(proof, "Check account", observation, [], provider);
    expect(result.status).toBe(status);
    expect(result.passed).toBe(status === "satisfied");
  });
}

test("malformed reviewer result is a protocol error", async () => {
  const provider: LLMProvider = { name: "fake", async generate() { return { provider: "fake", model: "reviewer", text: '{"status":"yes"}' }; } };
  expect(reviewJudgeProof(proof, "Check account", observation, [], provider)).rejects.toMatchObject({ name: "LLMError", kind: "malformed_response" });
});

test("reviewer evidence redacts credentials from instruction and observation", async () => {
  const provider: LLMProvider = { name: "fake", async generate(request) {
    expect(JSON.stringify(request.messages)).not.toContain("topsecret");
    return { provider: "fake", model: "reviewer", text: '{"status":"inconclusive","reason":"Not enough evidence"}' };
  } };
  await reviewJudgeProof(proof, "Password: topsecret", { ...observation, text: "Password: topsecret" }, [], provider);
});
