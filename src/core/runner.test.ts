import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgentAction } from "./agent";
import { parseScenario } from "./scenario";
import { scenarioContentHash } from "./run-store";
import { runScenario } from "./runner";
import { redactRecord } from "./recorder";
import { PlaywrightEnvironment } from "../environments/playwright";
import type { QAEnvironment } from "./environment";
import type { LLMProvider } from "./llm/provider";

test("scenario and model action boundaries reject malformed input", () => {
  expect(() => parseScenario({ name: "x", startUrl: "http://localhost", instruction: "do it", proof: [{ type: "unknown" }] })).toThrow();
  expect(() => parseAgentAction("click", { target: { by: "coordinates", x: "1", y: 2 } })).toThrow();
  expect(() => parseAgentAction("evaluate", { script: "alert(1)" })).toThrow();
});

test("judge proof requires text and changes scenario version content", () => {
  const base = { name: "x", startUrl: "http://localhost", instruction: "do it", proof: [{ type: "judge" as const, text: "The user is signed in." }] };
  expect(parseScenario(base).proof).toEqual(base.proof);
  expect(() => parseScenario({ ...base, proof: [{ type: "judge" }] })).toThrow();
  expect(() => parseScenario({ ...base, proof: [{ type: "judge", text: "  " }] })).toThrow();
  expect(scenarioContentHash(parseScenario(base))).not.toBe(scenarioContentHash(parseScenario({ ...base, proof: [{ type: "judge", text: "The account is active." }] })));
});

test("scenario duration is validated and versioned", () => {
  const base = { name: "x", startUrl: "http://localhost", instruction: "do it", proof: [{ type: "text_visible", text: "Done" }], maxDuration: "90m" };
  expect(parseScenario(base).maxDuration).toBe("90m");
  expect(() => parseScenario({ ...base, maxDuration: "later" })).toThrow();
  expect(scenarioContentHash(parseScenario(base))).not.toBe(scenarioContentHash(parseScenario({ ...base, maxDuration: "30m" })));
});

function changingEnvironment(): QAEnvironment {
  let state = 0;
  return {
    async start() {}, async navigate() {}, async close() {},
    async act() { state++; return { success: true }; },
    async observe() { return { platform: "web", location: { url: "http://localhost/" }, text: `State ${state}`, elements: [], errors: [] }; },
    async inspect() { return { count: 0, elements: [] }; },
    async screenshot(path) { await Bun.write(path, ""); },
  };
}

test("password input is masked before recording", () => {
  const record = redactRecord({ sequence: 1, action: { type: "fill", target: { by: "label", label: "Password" }, value: "sample-secret" },
    startedAt: new Date().toISOString(), durationMs: 1, status: "succeeded", observation: {
      platform: "web", location: {}, text: "sample-secret", elements: [{ label: "Password", value: "sample-secret", visible: true, enabled: true }], errors: [],
    } });
  expect(JSON.stringify(record)).not.toContain("sample-secret");
  expect(record.action).toEqual({ type: "fill", target: { by: "label", label: "Password" }, value: "[redacted]" });
});

test("runner executes one action, done and independent proof", async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response('<title>Test</title><button onclick="document.querySelector(\'p\').textContent=\'Created Ada\'">Create</button><p></p>', { headers: { "content-type": "text/html" } }) });
  const directory = await mkdtemp(join(tmpdir(), "qawarness-"));
  let turn = 0;
  let reviewerStatus: "satisfied" | "not_satisfied" = "satisfied";
  const provider: LLMProvider = { name: "fake", async generate(request) {
    if (!request.tools) return { provider: "fake", model: "reviewer", text: JSON.stringify({ status: reviewerStatus, reason: "Evidence checked." }) };
    if (turn === 0) expect(JSON.stringify(request.messages)).not.toContain("The page confirms Ada was created");
    const calls = [
      { id: "1", name: "click", arguments: { target: { by: "role", role: "button", name: "Create" } } },
      { id: "2", name: "done", arguments: { reason: "Created" } },
    ];
    return { provider: "fake", model: "fake", text: "", toolCalls: [calls[turn++]!] };
  } };
  try {
    const scenario = parseScenario({ name: "create", startUrl: `http://localhost:${server.port}/`, instruction: "Click Create", proof: [
      { type: "text_visible", text: "Created Ada" },
      { type: "text_not_visible", text: "Missing customer" },
      { type: "url_contains", value: `localhost:${server.port}` },
      { type: "element_visible", target: { by: "role", role: "button", name: "Create" } },
      { type: "element_text", target: { by: "role", role: "button", name: "Create" }, equals: "Create" },
      { type: "judge", text: "The page confirms Ada was created" },
    ] });
    const report = await runScenario(scenario, provider, new PlaywrightEnvironment({ tracePath: join(directory, "trace.zip") }), directory);
    expect(report.result).toBe("passed");
    expect(report.steps).toBe(2);
    expect(report.proofResults[0]?.passed).toBe(true);
    expect(report.proofResults).toHaveLength(6);
    expect(report.proofResults[5]).toMatchObject({ passed: true, status: "satisfied", reviewer: { provider: "fake", model: "reviewer" } });
    expect((await readFile(join(directory, "actions.jsonl"), "utf8")).trim().split("\n")).toHaveLength(2);
    expect((await Bun.file(join(directory, "final.png")).exists())).toBe(true);
    expect((await Bun.file(join(directory, "trace.zip")).exists())).toBe(true);
    turn = 0;
    reviewerStatus = "not_satisfied";
    const failed = await runScenario(scenario, provider, new PlaywrightEnvironment(), join(directory, "failed"));
    expect(failed.result).toBe("verification_failed");
    expect(failed.proofResults.slice(0, 5).every(proof => proof.passed)).toBe(true);
    expect(failed.proofResults[5]).toMatchObject({ passed: false, status: "not_satisfied" });
  } finally { server.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("runner stops repeated actions without visible progress", async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response("<button>Retry</button>", { headers: { "content-type": "text/html" } }) });
  const directory = await mkdtemp(join(tmpdir(), "qawarness-stalled-"));
  let calls = 0;
  const provider: LLMProvider = { name: "fake", async generate() {
    calls++;
    return { provider: "fake", model: "fake", text: "", toolCalls: [{ id: String(calls), name: "click", arguments: { target: { by: "role", role: "button", name: "Retry" } } }] };
  } };
  try {
    const scenario = parseScenario({ name: "stalled", startUrl: `http://localhost:${server.port}/`, instruction: "Complete the task", proof: [{ type: "text_visible", text: "Complete" }], maxSteps: 100 });
    const report = await runScenario(scenario, provider, new PlaywrightEnvironment(), directory);
    expect(report.result).toBe("stalled");
    expect(report.steps).toBe(5);
    expect(calls).toBe(5);
    expect(report.completionReason).toBeUndefined();
    expect(report.errors[0]).toContain("no visible state change");
    expect(report.proofResults).toEqual([]);
    expect((await readFile(join(directory, "actions.jsonl"), "utf8")).trim().split("\n")).toHaveLength(5);
  } finally { server.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("runner caps scenario requests at 200 steps and 90 minutes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qawarness-limits-"));
  let calls = 0;
  const provider: LLMProvider = { name: "fake", async generate() {
    calls++;
    return { provider: "fake", model: "fake", text: "", toolCalls: [{ id: String(calls), name: "scroll", arguments: { deltaY: calls } }] };
  } };
  try {
    const scenario = parseScenario({ name: "limits", startUrl: "http://localhost/", instruction: "Keep going", proof: [{ type: "text_visible", text: "Done" }], maxSteps: 5000, maxDuration: "2h" });
    const report = await runScenario(scenario, provider, changingEnvironment(), directory);
    expect(report.result).toBe("max_steps");
    expect(report.steps).toBe(200);
    expect(calls).toBe(200);
    expect(report.limits).toEqual({ maxSteps: 200, maxDurationMs: 90 * 60_000 });
    expect(report.scenario.maxSteps).toBe(5000);
    expect(report.proofResults).toEqual([]);
    expect(JSON.parse(await readFile(join(directory, "report.json"), "utf8")).limits).toEqual(report.limits);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("runner stops when duration expires during a provider request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qawarness-duration-"));
  let calls = 0;
  const provider: LLMProvider = { name: "fake", generate(request) {
    calls++;
    return new Promise((_, reject) => request.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  } };
  try {
    const scenario = parseScenario({ name: "duration", startUrl: "http://localhost/", instruction: "Keep going", proof: [{ type: "text_visible", text: "Done" }], maxDuration: "25ms" });
    const report = await runScenario(scenario, provider, changingEnvironment(), directory);
    expect(report.result).toBe("max_duration");
    expect(report.limits.maxDurationMs).toBe(25);
    expect(report.steps).toBe(0);
    expect(calls).toBe(1);
    expect(report.errors[0]).toContain("duration limit");
    expect(report.proofResults).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
