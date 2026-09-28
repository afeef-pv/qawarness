import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgentAction } from "./agent";
import { parseScenario } from "./scenario";
import { repeatScenario } from "./repeat";
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
    if (!request.tools) {
      const user = request.messages[1];
      expect(user?.role).toBe("user");
      expect(user?.role === "user" && Array.isArray(user.content) && user.content[1]?.type).toBe("image");
      if (user?.role === "user" && Array.isArray(user.content)) {
        expect(user.content[1]?.type === "image" && user.content[1].dataUrl.startsWith("data:image/png;base64,iVBOR")).toBe(true);
        const evidence = user.content[0];
        expect(evidence?.type === "text" && JSON.parse(evidence.text).actionHistory.map((step: { sequence: number }) => step.sequence)).toEqual([1, 2]);
      }
      return { provider: "fake", model: "reviewer", text: JSON.stringify({ status: reviewerStatus, reason: "Evidence checked." }) };
    }
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
    expect(report.proofResults[5]).toMatchObject({ evidence: { screenshot: join(directory, "final.png"), stepSequences: [1, 2] } });
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

test("failed actions and done retain screenshots beside their recorded observations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qawarness-evidence-"));
  let turn = 0;
  const provider: LLMProvider = { name: "fake", async generate() {
    const calls = [
      { id: "1", name: "click", arguments: { target: { by: "text", text: "Missing" } } },
      { id: "2", name: "done", arguments: { reason: "Ready" } },
    ];
    return { provider: "fake", model: "fake", text: "", toolCalls: [calls[turn++]!] };
  } };
  const environment: QAEnvironment = { ...changingEnvironment(), async act() { return { success: false, error: "Missing target" }; } };
  try {
    const scenario = parseScenario({ name: "evidence", startUrl: "http://localhost/", instruction: "Try to click", proof: [{ type: "text_visible", text: "State 0" }] });
    const report = await runScenario(scenario, provider, environment, directory);
    const records = (await readFile(join(directory, "actions.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(report.result).toBe("passed");
    expect(records.map(record => record.status)).toEqual(["failed", "done"]);
    expect(records[0].observation.text).toBe("State 0");
    expect(records[0].screenshot).toBe(join(directory, "steps", "000001-failed.png"));
    expect(records[1].screenshot).toBe(join(directory, "final.png"));
    expect(await Bun.file(records[0].screenshot).exists()).toBe(true);
    expect(await Bun.file(records[1].screenshot).exists()).toBe(true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("repeat runs reset a stateful app and temporal proof rejects a preexisting success message", async () => {
  let saved = false;
  let resets = 0;
  const server = Bun.serve({ port: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/reset" && request.method === "POST") { saved = false; resets++; return new Response("reset"); }
    if (url.pathname === "/save" && request.method === "POST") { saved = true; return Response.redirect(new URL("/", request.url), 303); }
    return new Response(`<form action="/save" method="post"><button>Save</button></form><p>${saved ? "Saved" : "Unsaved"}</p>`, { headers: { "content-type": "text/html" } });
  } });
  const directory = await mkdtemp(join(tmpdir(), "qawarness-repeat-"));
  const scenario = parseScenario({ name: "save", startUrl: `http://localhost:${server.port}/`, instruction: "Click Save", proof: [
    { type: "text_visible_after_click", target: { by: "role", role: "button", name: "Save" }, text: "Saved" },
    { type: "no_application_errors" },
  ] });
  const run = async (index: number) => {
    let turn = 0;
    const provider: LLMProvider = { name: "fake", async generate() {
      const calls = [
        { id: "1", name: "click", arguments: { target: { by: "role", role: "button", name: "Save" } } },
        { id: "2", name: "done", arguments: { reason: "Saved" } },
      ];
      return { provider: "fake", model: "fake", text: "", toolCalls: [calls[turn++]!] };
    } };
    return runScenario(scenario, provider, new PlaywrightEnvironment(), join(directory, `run-${index}`),
      { agentModel: "fake", context: { applicationRevision: "app-v1", fixture: "empty-store", harnessRevision: "test" } });
  };
  try {
    const summary = await repeatScenario(scenario, 2, async () => {
      const response = await fetch(`http://localhost:${server.port}/reset`, { method: "POST" });
      expect(response.ok).toBe(true);
    }, run);
    expect(resets).toBe(2);
    expect(summary.passRate).toBe(1);
    expect(summary.diagnosisCounts.passed).toBe(2);
    expect(summary.context.environment?.version).toBeTruthy();
    expect(summary.context.environment?.viewport).toEqual({ width: 1280, height: 720 });
    const persisted = JSON.parse(await readFile(join(directory, "run-0", "report.json"), "utf8"));
    expect(persisted).toMatchObject({ execution: { status: "done" }, verification: { status: "passed" }, diagnosis: { classification: "passed" },
      context: { applicationRevision: "app-v1", fixture: "empty-store", modelSettings: { temperature: 0 } } });
    expect(await Bun.file(join(directory, "run-0", "initial-observation.json")).exists()).toBe(true);
    const misleading = await run(2);
    expect(misleading.result).toBe("verification_failed");
    expect(misleading.verification.status).toBe("failed");
    expect(misleading.proofResults[0]).toMatchObject({ passed: false, observed: { finalVisible: true } });
    expect(misleading.diagnosis.classification).toBe("inconclusive");
  } finally { server.stop(true); await rm(directory, { recursive: true, force: true }); }
});
