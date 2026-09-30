import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QAEnvironment } from "./environment";
import type { LLMProvider } from "./llm/provider";
import { investigateRecordedFailure, loadRecordedRun } from "./investigator";
import { runScenario } from "./runner";
import { parseScenario } from "./scenario";

const scenario = parseScenario({ name: "save", startUrl: "http://localhost/", instruction: "Save. Password: hidden-secret", proof: [{ type: "text_visible", text: "Saved" }] });
function environment(onClose: () => void): QAEnvironment {
  return { async start() {}, async navigate() {}, async close() { onClose(); }, async act() { throw new Error("Must not drive during investigation"); },
    async inspect() { return { count: 0, elements: [] }; },
    async observe() { return { platform: "web", location: {}, text: "Unsaved hidden-secret", elements: [], errors: [] }; },
    async screenshot(path) { await Bun.write(path, "recorded image"); } };
}

test("failed run investigation reads recorded evidence after browser close and cannot change proof verdicts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qawarness-investigation-"));
  let closed = false, turn = 0, executionCalls = 0;
  const provider: LLMProvider = { name: "fake", async generate(request) {
    if (!request.tools?.some(tool => tool.name === "finish_investigation")) {
      executionCalls++;
      return { provider: "fake", model: "driver", text: "", toolCalls: [{ id: "done", name: "done", arguments: { reason: "Saved" } }] };
    }
    expect(closed).toBe(true);
    expect(JSON.stringify(request.messages)).not.toContain("hidden-secret");
    const call = [
      { name: "read_steps", arguments: { from: 1, count: 1 } },
      { name: "view_screenshot", arguments: { id: "step-1-before" } },
      { name: "finish_investigation", arguments: { classification: "agent_failure", reason: "Step 1 called done without saving; the screen is Unsaved", proofIndexes: [0], errorIndexes: [] } },
    ][turn++]!;
    return { provider: "fake", model: "investigator", text: "", toolCalls: [{ id: String(turn), ...call }] };
  } };
  try {
    const report = await runScenario(scenario, provider, environment(() => { closed = true; }), directory);
    expect(executionCalls).toBe(1);
    expect(report).toMatchObject({ result: "verification_failed", execution: { status: "done" }, verification: { status: "failed" },
      investigation: { status: "completed", reviewer: { model: "investigator" } }, diagnosis: { classification: "agent_failure", evidence: { stepSequences: [1], proofIndexes: [0] } } });
    expect(report.proofResults[0]?.passed).toBe(false);
    expect(report.diagnosis.evidence.screenshots).toContain(join(directory, "agent-screens", "000000.png"));
    const { report: saved, history } = await loadRecordedRun(directory);
    expect(saved.diagnosis).toEqual(report.diagnosis);
    expect(history[0]?.beforeScreenshot).toBeTruthy();
    expect(JSON.parse(await readFile(join(directory, "investigation.json"), "utf8")).status).toBe("completed");
    expect(await readFile(join(directory, "investigation.jsonl"), "utf8")).not.toContain("data:image");
    const original = JSON.stringify(report);
    const failing: LLMProvider = { name: "fake", async generate() { throw new Error("Provider offline"); } };
    const failed = await investigateRecordedFailure(report, history, directory, failing);
    expect(failed).toMatchObject({ status: "failed", error: "Provider offline" });
    expect(JSON.stringify(report)).toBe(original);
    const invalid: LLMProvider = { name: "fake", async generate() { return { provider: "fake", model: "fake", text: "", toolCalls: [{ id: "end", name: "finish_investigation", arguments: { classification: "product_failure", reason: "Guessed", proofIndexes: [99], errorIndexes: [] } }] }; } };
    expect((await investigateRecordedFailure(report, history, directory, invalid)).status).toBe("failed");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("investigation failure preserves the baseline result and diagnosis, with a recorded error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qawarness-investigation-failed-"));
  const provider: LLMProvider = { name: "fake", async generate(request) {
    if (request.tools?.some(tool => tool.name === "finish_investigation")) throw new Error("Review provider unavailable");
    return { provider: "fake", model: "fake", text: "", toolCalls: [{ id: "done", name: "done", arguments: { reason: "Ready" } }] };
  } };
  try {
    const report = await runScenario(scenario, provider, environment(() => {}), directory);
    expect(report).toMatchObject({ result: "verification_failed", diagnosis: { classification: "inconclusive" }, investigation: { status: "failed", error: "Review provider unavailable" } });
    expect((await loadRecordedRun(directory)).report.investigation).toEqual(report.investigation);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
