import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecordedEvidence, runEvidenceReview } from "./evidence";
import type { LLMProvider } from "./llm/provider";
import { reviewJudgeProof } from "./reviewer";

const observation = { platform: "web" as const, location: {}, text: "Final", elements: [], errors: [] };
const finish = { name: "finish_review", description: "Finish", inputSchema: { type: "object" } };

test("proof reviewer retrieves early steps, paged observations and historical images beyond its initial bundle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qawarness-evidence-reader-"));
  try {
    const final = join(directory, "final.png"), early = join(directory, "early.png");
    await Bun.write(final, "final image"); await Bun.write(early, "early image");
    const history = Array.from({ length: 45 }, (_, index) => ({ sequence: index + 1,
      action: { type: "click" as const, target: { by: "text" as const, text: "Save" } },
      startedAt: "2026-01-01T00:00:00Z", durationMs: 1, status: "succeeded" as const,
      ...(index === 0 ? { beforeScreenshot: early } : {}),
      observation: { ...observation, text: index === 0 ? "x".repeat(4000) + "Password: hidden-secret\nAuthorization: Bearer hidden-token" : `State ${index}` },
    }));
    let turn = 0;
    const provider: LLMProvider = { name: "fake", async generate(request) {
      expect(JSON.stringify(request.messages)).not.toContain("hidden-secret");
      expect(JSON.stringify(request.messages)).not.toContain("hidden-token");
      expect(request.tools?.map(tool => tool.name)).not.toContain("click");
      const images = request.messages.flatMap(message => message.role === "user" && Array.isArray(message.content) ? message.content.filter(part => part.type === "image") : []);
      expect(images.length).toBeLessThanOrEqual(1);
      const call = [
        { name: "read_steps", arguments: { from: 1, count: 1 } },
        { name: "read_observation", arguments: { sequence: 1, offset: 4000 } },
        { name: "list_screenshots", arguments: { offset: 0 } },
        { name: "view_screenshot", arguments: { id: "step-1-before" } },
        { name: "finish_review", arguments: { status: "not_satisfied", reason: "Step 1 shows failure" } },
      ][turn]!;
      if (turn === 2) expect(JSON.stringify(request.messages)).toContain("[redacted]");
      if (turn === 4) expect(images[0]).toMatchObject({ dataUrl: "data:image/png;base64," + Buffer.from("early image").toString("base64") });
      turn++;
      return { provider: "fake", model: "reviewer", text: "", toolCalls: [{ id: String(turn), ...call }] };
    } };
    const result = await reviewJudgeProof({ type: "judge", text: "Save succeeded" }, "Password: hidden-secret", observation, history, provider, undefined, final);
    expect(result.passed).toBe(false);
    expect(result.evidence.stepSequences).toContain(1);
    expect(result.evidence.screenshots).toEqual([final, early]);
    const log = await readFile(join(directory, "review.jsonl"), "utf8");
    expect(log).toContain("read_observation"); expect(log).not.toContain("hidden-secret"); expect(log).not.toContain("data:image");
    expect(log).not.toContain("hidden-token");
    expect(log.trim().split("\n").map(line => JSON.parse(line))).toHaveLength(6);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("evidence access rejects arbitrary paths, foreign references, symlink escapes and oversized pages", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qawarness-evidence-paths-"));
  const outside = await mkdtemp(join(tmpdir(), "qawarness-outside-"));
  try {
    const secret = join(outside, "secret.png"); await Bun.write(secret, "outside");
    const link = join(directory, "linked.png"); await symlink(secret, link);
    const evidence = new RecordedEvidence({ directory, instruction: "Check", history: [], screenshot: link });
    await expect(evidence.read("view_screenshot", { id: secret })).rejects.toThrow("Unknown recorded screenshot");
    await expect(evidence.image("final")).rejects.toThrow("outside this run");
    await expect(evidence.read("read_steps", { from: 1, count: 500 })).rejects.toThrow("Invalid evidence page");
    await expect(evidence.read("click", {})).rejects.toThrow("Unknown read-only");
    expect(evidence.viewedScreenshots.size).toBe(0);
  } finally { await rm(directory, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test("review tools return missing evidence as errors and enforce turn and cancellation limits", async () => {
  const evidence = new RecordedEvidence({ directory: ".", instruction: "Check", history: [] });
  let calls = 0;
  const provider: LLMProvider = { name: "fake", async generate(request) {
    if (calls) expect(JSON.stringify(request.messages)).toContain("Recorded observation unavailable");
    calls++;
    return { provider: "fake", model: "fake", text: "", toolCalls: [{ id: String(calls), name: "read_observation", arguments: { sequence: 1, offset: 0 } }] };
  } };
  await expect(runEvidenceReview(evidence, provider, { system: "Review", summary: "Check", finish })).rejects.toThrow("12-turn");
  expect(calls).toBe(12);
  await expect(runEvidenceReview(evidence, provider, { system: "Review", summary: "Check", finish, signal: AbortSignal.abort() })).rejects.toThrow();
  expect(calls).toBe(12);
});

test("a model cannot pass judge proof without final visual evidence", async () => {
  const provider: LLMProvider = { name: "fake", async generate() { return { provider: "fake", model: "fake", text: "", toolCalls: [{ id: "finish", name: "finish_review", arguments: { status: "satisfied", reason: "Looks fine" } }] }; } };
  const result = await reviewJudgeProof({ type: "judge", text: "Saved" }, "Save", observation, [], provider);
  expect(result).toMatchObject({ passed: false, status: "inconclusive" });
});
