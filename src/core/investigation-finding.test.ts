import { expect, test } from "bun:test";
import { RecordedEvidence } from "./evidence";
import { validateFinding } from "./investigation-finding";

const finding = (citations: unknown[]) => ({ expected: "Save", observed: "Unsaved", cause: "Stopped early", alternativeExplanation: "Saved elsewhere", alternativeAssessment: "No recorded Save", unknowns: [], neededEvidence: [], citations });
test("citations require successful content access, not unrelated access or listing", async () => {
  const evidence = new RecordedEvidence({ directory: ".", instruction: "Save", history: [{ sequence: 1, action: { type: "done", reason: "Ready" }, status: "done", startedAt: "now", durationMs: 1,
    observation: { platform: "web", location: {}, text: "x".repeat(5000), elements: [], errors: [] }, screenshot: "missing.png" }] });
  const validate = (citations: unknown[]) => validateFinding(finding(citations), "agent_failure", evidence, 1, 1);
  const step = { claim: "cause", kind: "step", sequence: 1 };
  expect(() => validate([step])).toThrow();
  await evidence.read("list_screenshots", { offset: 0 });
  await expect(evidence.image("step-1-after")).rejects.toThrow();
  expect(() => validate([{ claim: "cause", kind: "screenshot", id: "step-1-after" }])).toThrow();
  await evidence.read("read_steps", { from: 1, count: 1 });
  expect(validate([step]).citations).toHaveLength(1);
  expect(() => validate([{ ...step, sequence: 99 }])).toThrow();
  const range = { claim: "cause", kind: "observation", sequence: 1, start: 900, end: 1100 };
  expect(() => validate([range])).toThrow();
  await evidence.read("read_observation", { sequence: 1, offset: 1000 });
  expect(validate([{ ...range, start: 1000 }]).citations).toHaveLength(1);
  expect(() => validate([{ ...range, end: 6000 }])).toThrow();
  expect(() => validateFinding(finding([{ claim: "cause", kind: "proof", index: 0 }]), "product_failure", evidence, 1, 1)).toThrow();
  expect(() => validate([{ claim: "cause", kind: "error", index: 1 }])).toThrow();
});

test("diagnostic citation needs retrieved events and repeated snapshots deduplicate", async () => {
  const event = { schemaVersion: 1 as const, id: "diagnostic-1", source: "application" as const, kind: "http_error" as const, occurredAt: "2026-01-01T00:00:01Z", message: "HTTP 500", request: { id: "request-1", startedAt: "2026-01-01T00:00:00Z", method: "POST", url: "http://fixture.invalid/save", status: 500 } };
  const observation = { platform: "web" as const, location: {}, text: "Save failed", elements: [], errors: [], diagnostics: [event] };
  const evidence = new RecordedEvidence({ directory: ".", instruction: "Save", history: [], initialObservation: observation, finalObservation: observation });
  const citation = { claim: "cause", kind: "diagnostic", id: event.id } as const;
  expect(() => validateFinding(finding([citation]), "product_failure", evidence, 1, 0)).toThrow();
  const page = JSON.parse((await evidence.read("read_diagnostics", { offset: 0 })).text);
  expect(page.total).toBe(1);
  expect(page.events[0].request.status).toBe(500);
  expect(validateFinding(finding([citation]), "product_failure", evidence, 1, 0).citations).toEqual([citation]);
  expect(() => validateFinding(finding([{ ...citation, id: "invented" }]), "product_failure", evidence, 1, 0)).toThrow();
});

test("attribution rubric requires separate cited claims and actionable abstention", async () => {
  const evidence = new RecordedEvidence({ directory: ".", instruction: "Save", history: [{ sequence: 1, action: { type: "done", reason: "Ready" }, status: "done", startedAt: "now", durationMs: 1 }] });
  await evidence.read("read_steps", { from: 1, count: 1 });
  const citations = [
    { claim: "observed", kind: "step", sequence: 1 },
    { claim: "cause", kind: "step", sequence: 1 },
    { claim: "alternative", kind: "step", sequence: 1 },
  ];
  const validate = (value: unknown, classification = "agent_failure") => validateFinding(value, classification, evidence, 1, 0, { attributionRubric: true });
  expect(validate(finding(citations)).cause).toBe("Stopped early");
  for (const missing of ["observed", "cause", "alternative"]) expect(() => validate(finding(citations.filter(c => c.claim !== missing)))).toThrow();
  for (const classification of ["product_failure", "agent_failure", "harness_failure"]) {
    expect(() => validate(finding(citations.map(c => c.claim === "cause" ? { claim: "cause", kind: "proof", index: 0 } : c)), classification)).toThrow();
  }
  const inconclusive = { ...finding([]), cause: null, unknowns: ["App failure or delayed request"], neededEvidence: [] };
  expect(() => validate(inconclusive, "inconclusive")).toThrow("distinguishing evidence");
  expect(validate({ ...inconclusive, neededEvidence: ["Response completion and screen after loading settles"] }, "inconclusive").cause).toBeNull();
  expect(() => validate({ ...inconclusive, cause: "Probably a backend bug", neededEvidence: ["Logs"] }, "inconclusive")).toThrow();
});
