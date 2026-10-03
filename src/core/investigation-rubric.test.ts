import { expect, test } from "bun:test";
import { investigateRecordedFailure, loadRecordedRun, saveInvestigation } from "./investigator";
import { investigationRubric } from "./investigation-rubric";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Scripted replies exercise the review contract, not real-model accuracy.
const cases = [
  { id: "premature-done", classification: "agent_failure", observed: "Only done was recorded", cause: "Driver stopped before Save", alternative: "Save operation broke", assessment: "No Save action was attempted", needed: [] },
  { id: "save-app-error", classification: "product_failure", observed: "Save returned HTTP 500 and displayed failure", cause: "Save operation failed", alternative: "Wrong control was clicked", assessment: "Recorded click targets Save and the response is for Save", needed: [] },
  { id: "provider-outage", classification: "harness_failure", observed: "Provider request failed", cause: "Provider was unavailable", alternative: "Product defect", assessment: "Provider failure is recorded separately from app state", needed: [] },
  { id: "ambiguous-stall", classification: "inconclusive", observed: "Loading did not finish", cause: null, alternative: "App failure or unfinished loading", assessment: "No completion evidence distinguishes them", needed: ["Request completion and later screen"] },
  { id: "background-http-error", classification: "inconclusive", observed: "Background request failed before Save", cause: null, alternative: "Save failed or has not finished", assessment: "Background endpoint and timing do not establish Save's outcome", needed: ["Save request outcome"] },
  { id: "ambiguous-click", classification: "inconclusive", observed: "Click matched two Save controls", cause: null, alternative: "Incorrect target or insufficient target identity", assessment: "No image distinguishes intended target", needed: ["Image and labels of both controls"] },
] as const;

test("rubric findings persist symptoms, supported explanations and abstention without changing QA results", async () => {
  const destination = await mkdtemp(join(tmpdir(), "investigation-rubric-"));
  try {
    for (const item of cases) {
      const directory = `fixtures/investigation/cases/${item.id}`;
      const { report, history } = await loadRecordedRun(directory);
      const original = JSON.stringify(report);
      let turn = 0;
      const result = await investigateRecordedFailure(report, history, directory, { name: "scripted", async generate(request) {
        expect(request.messages[0]).toEqual({ role: "system", content: expect.stringContaining(investigationRubric.instruction) });
        const attributed = item.classification !== "inconclusive";
        const call = turn++ === 0 ? { name: "read_steps", arguments: { from: 1, count: 10 } }
          : turn === 2 && item.id === "save-app-error" ? { name: "read_diagnostics", arguments: { offset: 0 } }
          : { name: "finish_investigation", arguments: {
            classification: item.classification, reason: item.cause ?? item.assessment, proofIndexes: [], errorIndexes: item.id === "provider-outage" ? [0] : [],
            finding: { expected: report.scenario.instruction, observed: item.observed, cause: item.cause, alternativeExplanation: item.alternative,
              alternativeAssessment: item.assessment, unknowns: attributed ? ["Internal implementation was not inspected"] : [item.assessment], neededEvidence: [...item.needed],
              citations: [{ claim: "observed", kind: "step", sequence: 1 }, ...(attributed ? [
                item.id === "provider-outage" ? { claim: "cause", kind: "error", index: 0 }
                  : item.id === "save-app-error" ? { claim: "cause", kind: "diagnostic", id: "diagnostic-1" } : { claim: "cause", kind: "step", sequence: 1 },
                { claim: "alternative", kind: "step", sequence: 1 },
              ] : [])] },
          } };
        return { provider: "scripted", model: "contract-test", text: "", toolCalls: [{ id: String(turn), ...call }] };
      } });
      expect(result.status).toBe("completed");
      expect(result.schemaVersion).toBe(2);
      expect(result.attempt?.rubricVersion).toBe(1);
      expect(result.diagnosis?.classification).toBe(item.classification);
      expect(result.finding?.cause).toBe(item.cause);
      expect(JSON.stringify(report)).toBe(original);
      const path = join(destination, `${item.id}.json`);
      await saveInvestigation(path, result);
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual(result);
      await expect(saveInvestigation(path, result)).rejects.toThrow();
    }
  } finally { await rm(destination, { recursive: true, force: true }); }
});
