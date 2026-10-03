import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateInvestigations } from "./investigation-eval";

test("benchmark compares repeated identical snapshots without exposing labels or prior reviews", async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), "investigation-eval-"));
  const inputs = new Set<string>();
  try {
    const summary = await evaluateInvestigations("fixtures/investigation/manifest.json", { name: "fake", async generate(request) {
      const text = JSON.stringify(request.messages);
      expect(text).not.toContain("requiredClaim"); expect(text).not.toContain("unsupportedClaims"); expect(text).not.toContain("supportingSteps");
      inputs.add(text);
      const structured = JSON.stringify(request.tools?.at(-1)).includes('"finding"');
      return { provider: "fake", model: "fake", text: "", toolCalls: [{ id: "finish", name: "finish_investigation", arguments: {
        classification: "inconclusive", reason: "Cannot distinguish causes", proofIndexes: [], errorIndexes: [],
        ...(structured ? { finding: { expected: "Save", observed: "Proof failed", cause: null, alternativeExplanation: "Driver or app", alternativeAssessment: "Need more evidence", unknowns: ["Cause"], neededEvidence: ["Transition"], citations: [] } } : {}),
      } }] };
    } }, { trials: 2, outputRoot });
    const manifest = JSON.parse(await readFile("fixtures/investigation/manifest.json", "utf8"));
    expect(summary.results).toHaveLength(manifest.cases.length * 4);
    expect(summary.results.every(r => r.investigation.status === "completed")).toBe(true);
    expect(summary.results.every(r => r.usage === null && r.cost === null)).toBe(true);
    for (const id of new Set(summary.results.map(r => r.caseId))) expect(new Set(summary.results.filter(r => r.caseId === id).map(r => r.fingerprint)).size).toBe(1);
    expect(JSON.parse(await readFile(join(summary.destination, "summary.json"), "utf8")).aggregate).toHaveLength(4);
    const bad = join(outputRoot, "manifest.json");
    await writeFile(bad, JSON.stringify({ schemaVersion: 1, cases: [{ id: "missing", split: "development", directory: "absent", expected: { classification: "inconclusive", requiredClaim: "Unknown", supportingSteps: [], unsupportedClaims: [] } }] }));
    let called = false;
    await expect(evaluateInvestigations(bad, { name: "fake", async generate() { called = true; throw Error("Must not call"); } }, { trials: 1, outputRoot })).rejects.toThrow();
    expect(called).toBe(false);
  } finally { await rm(outputRoot, { recursive: true, force: true }); }
});

test("settings comparison uses identical structured inputs and records each effective reviewer", async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), "investigation-settings-eval-"));
  const inputs: string[][] = [[], []];
  const provider = (index: number) => ({ name: `provider-${index}`, settings: { model: `model-${index}`, reasoning: index ? "high" : "none", temperature: index ? null : 0 }, async generate(request: import("./core/llm/provider").LLMRequest) {
    inputs[index]!.push(JSON.stringify(request.messages));
    expect(JSON.stringify(request.tools?.at(-1))).toContain('"finding"');
    return { provider: `provider-${index}`, model: `returned-${index}`, text: "", usage: { inputTokens: 4, outputTokens: 2 }, toolCalls: [{ id: "finish", name: "finish_investigation", arguments: {
      classification: "inconclusive", reason: "Unresolved", proofIndexes: [], errorIndexes: [], finding: { expected: "Save", observed: "Failed proof", cause: null, alternativeExplanation: "App or agent", alternativeAssessment: "Missing distinguishing evidence", unknowns: ["Cause"], neededEvidence: ["Workflow transition evidence"], citations: [] },
    } }] };
  } });
  try {
    const summary = await evaluateInvestigations("fixtures/investigation/manifest.json", provider(0), { trials: 1, outputRoot, comparisonProvider: provider(1), maxTurns: 2 });
    expect(inputs[0]).toEqual(inputs[1]);
    const row = summary.results.find(r => r.contract === "structured")!;
    expect(row.investigation.attempt).toMatchObject({ requestedModel: "model-1", returnedModels: ["returned-1"], maxTurns: 2, modelCalls: 1, usage: { inputTokens: 4, outputTokens: 2 } });
    expect(summary.results.find(r => r.contract === "baseline")!.investigation.attempt?.maxTurns).toBe(12);
    const saved = JSON.parse(await readFile(join(summary.destination, `${row.caseId}-structured-1`, "attempt.json"), "utf8"));
    expect(saved.settings.settings.reasoning).toBe("high");
  } finally { await rm(outputRoot, { recursive: true, force: true }); }
});

test("rubric comparison isolates guidance and validation on the same evidence and budget", async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), "investigation-rubric-eval-"));
  const inputs: string[] = [];
  try {
    const provider = { name: "fake", async generate(request: import("./core/llm/provider").LLMRequest) {
      inputs.push(JSON.stringify(request.messages.slice(1)));
      return { provider: "fake", model: "same-model", text: "", toolCalls: [{ id: "finish", name: "finish_investigation", arguments: {
        classification: "inconclusive", reason: "Insufficient evidence", proofIndexes: [], errorIndexes: [], finding: {
          expected: "Save", observed: "Missing confirmation", cause: null, alternativeExplanation: "Driver or app", alternativeAssessment: "Unresolved", unknowns: ["Cause"], neededEvidence: ["Save transition evidence"], citations: [],
        },
      } }] };
    } };
    const summary = await evaluateInvestigations("fixtures/investigation/manifest.json", provider, { trials: 1, outputRoot, compareAttributionRubric: true });
    expect(summary.comparison).toBe("attribution_rubric");
    for (let i = 0; i < inputs.length; i += 2) expect(inputs[i]).toBe(inputs[i + 1]);
    for (const baseline of summary.results.filter(r => r.contract === "baseline")) {
      const candidate = summary.results.find(r => r.caseId === baseline.caseId && r.contract === "structured")!;
      expect(baseline.investigation).toMatchObject({ schemaVersion: 1, attempt: { promptVersion: "structured-v2", maxTurns: 12, maxDurationMs: 60000 } });
      expect(candidate.investigation).toMatchObject({ schemaVersion: 2, attempt: { promptVersion: "structured-v3", rubricVersion: 1, maxTurns: 12, maxDurationMs: 60000 } });
      expect(baseline.fingerprint).toBe(candidate.fingerprint);
      expect(baseline.investigation.attempt?.promptHash).not.toBe(candidate.investigation.attempt?.promptHash);
    }
    await expect(evaluateInvestigations("fixtures/investigation/manifest.json", provider, { trials: 1, outputRoot, compareAttributionRubric: true, maxTurns: 2 })).rejects.toThrow("independently");
  } finally { await rm(outputRoot, { recursive: true, force: true }); }
});
