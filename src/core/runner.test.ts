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
