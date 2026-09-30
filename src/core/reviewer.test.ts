import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LLMProvider } from "./llm/provider";
import { reviewJudgeProof } from "./reviewer";

const proof = { type: "judge" as const, text: "The account is active" };
const observation = { platform: "web" as const, location: { url: "http://localhost/account" }, text: "Account active", elements: [], errors: [] };

for (const status of ["satisfied", "not_satisfied", "inconclusive"] as const) {
  test(`reviewer ${status} result controls proof pass`, async () => {
    const provider: LLMProvider = { name: "fake", async generate(request) {
      expect(request.tools?.map(tool => tool.name)).toContain("read_steps");
      return { provider: "fake", model: "reviewer", text: "", toolCalls: [{ id: "finish", name: "finish_review", arguments: { status, reason: "Evidence checked" } }] };
    } };
    const directory = await mkdtemp(join(tmpdir(), "qawarness-review-"));
    try {
      const screenshot = join(directory, "final.png");
      await Bun.write(screenshot, "image bytes");
      const result = await reviewJudgeProof(proof, "Check account", observation, [], provider, undefined, screenshot);
      expect(result.status).toBe(status);
      expect(result.passed).toBe(status === "satisfied");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}

test("malformed reviewer result is a protocol error", async () => {
  const provider: LLMProvider = { name: "fake", async generate() { return { provider: "fake", model: "reviewer", text: '{"status":"yes"}' }; } };
  expect(reviewJudgeProof(proof, "Check account", observation, [], provider)).rejects.toMatchObject({ name: "LLMError", kind: "malformed_response" });
});

test("reviewer evidence redacts credentials from instruction and observation", async () => {
  const provider: LLMProvider = { name: "fake", async generate(request) {
    expect(JSON.stringify(request.messages)).not.toContain("topsecret");
    return { provider: "fake", model: "reviewer", text: "", toolCalls: [{ id: "finish", name: "finish_review", arguments: { status: "inconclusive", reason: "Not enough evidence" } }] };
  } };
  await reviewJudgeProof(proof, "Password: topsecret", { ...observation, text: "Password: topsecret" }, [{
    sequence: 1, action: { type: "fill", target: { by: "label", label: "Password" }, value: "[redacted]" },
    startedAt: new Date().toISOString(), durationMs: 1, status: "failed", error: "Password: topsecret",
    observation: { ...observation, text: "Password: topsecret" },
    inspection: { count: 1, elements: [{ label: "Password", value: "topsecret", visible: true, enabled: true }] },
  }], provider);
});

test("reviewer receives the final image and bounded step evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qawarness-reviewer-"));
  const screenshot = join(directory, "final.png");
  try {
    await Bun.write(screenshot, "image bytes");
    const history = Array.from({ length: 10 }, (_, index) => ({
      sequence: index + 1, action: { type: "click" as const, target: { by: "text" as const, text: "Save" } },
      startedAt: new Date().toISOString(), durationMs: 1, status: "succeeded" as const,
      observation: { ...observation, text: index === 9 ? "Saved account" : `State ${index}` },
    }));
    const provider: LLMProvider = { name: "fake", async generate(request) {
      const user = request.messages[1];
      expect(user?.role).toBe("user");
      if (user?.role !== "user" || !Array.isArray(user.content)) throw new Error("Missing reviewer image");
      expect(user.content[1]).toEqual({ type: "image", dataUrl: "data:image/png;base64,aW1hZ2UgYnl0ZXM=", detail: "original" });
      const text = user.content[0];
      if (text?.type !== "text") throw new Error("Missing reviewer text");
      const evidence = JSON.parse(text.text);
      expect(evidence.recentObservations).toHaveLength(8);
      expect(evidence.recentObservations[0].sequence).toBe(3);
      expect(evidence.actionHistory).toHaveLength(10);
      return { provider: "fake", model: "reviewer", text: "", toolCalls: [{ id: "finish", name: "finish_review", arguments: { status: "satisfied", reason: "Visible in the image" } }] };
    } };
    const result = await reviewJudgeProof(proof, "Check account", observation, history, provider, undefined, screenshot);
    expect(result.evidence).toEqual({ screenshot, screenshots: [screenshot], stepSequences: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
