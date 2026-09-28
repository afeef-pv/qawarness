import { expect, test } from "bun:test";
import { diagnoseRun } from "./diagnosis";
import type { ExecutionRecord } from "./recorder";

const done: ExecutionRecord = { sequence: 3, action: { type: "done", reason: "Finished" }, startedAt: "2026-01-01T00:00:00Z", durationMs: 1, status: "done", screenshot: "runs/test/final.png" };

test("diagnosis keeps proof failure distinct from agent failure", () => {
  const failedProof = [{ proof: { type: "text_visible" as const, text: "Saved" }, passed: false, observed: false }];
  const failed = diagnoseRun("verification_failed", failedProof, [done], []);
  expect(failed).toMatchObject({ classification: "inconclusive", evidence: { stepSequences: [3], proofIndexes: [0], screenshots: ["runs/test/final.png"] } });
  const protocol = diagnoseRun("agent_protocol_error", [], [], ["Agent repeatedly sent invalid QA tool arguments."]);
  expect(protocol).toMatchObject({ classification: "agent_failure", evidence: { errorIndexes: [0] } });
  expect(diagnoseRun("stalled", [], [done], ["No visible progress"])).toMatchObject({ classification: "inconclusive", evidence: { stepSequences: [3] } });
});

test("diagnosis attributes known infrastructure failures without claiming a product defect", () => {
  expect(diagnoseRun("provider_failure", [], [], ["Provider unavailable"])).toMatchObject({ classification: "harness_failure", reason: "Provider unavailable" });
  expect(diagnoseRun("passed", [{ proof: { type: "text_visible", text: "Saved" }, passed: true, observed: true }], [done], [])).toMatchObject({ classification: "passed", evidence: { proofIndexes: [0] } });
});

test("uncaught page error under an explicit no-error proof is a product failure", () => {
  const proof = { proof: { type: "no_application_errors" as const }, passed: false, observed: ["pageerror: Cannot save"] };
  expect(diagnoseRun("verification_failed", [proof], [done], ["pageerror: Cannot save"]))
    .toMatchObject({ classification: "product_failure", evidence: { proofIndexes: [0], errorIndexes: [0] } });
});
