import type { ExecutionRecord } from "./recorder";
import type { RunStatus } from "./runner";
import type { ProofResult } from "./verifier";

export type DiagnosisClassification = "passed" | "product_failure" | "agent_failure" | "harness_failure" | "inconclusive";

export interface RunDiagnosis {
  classification: DiagnosisClassification;
  reason: string;
  evidence: { stepSequences: number[]; proofIndexes: number[]; errorIndexes: number[]; screenshots: string[] };
}

export function diagnoseRun(result: RunStatus, proofs: ProofResult[], history: ExecutionRecord[], errors: string[]): RunDiagnosis {
  const failedProofIndexes = proofs.flatMap((proof, index) => proof.passed ? [] : [index]);
  const relevantSteps = result === "passed" || result === "verification_failed"
    ? history.filter(record => record.status === "done")
    : history.slice(-5);
  const evidence = {
    stepSequences: relevantSteps.map(record => record.sequence),
    proofIndexes: result === "passed" ? proofs.map((_, index) => index) : failedProofIndexes,
    errorIndexes: errors.length ? [0] : [],
    screenshots: [...new Set(relevantSteps.flatMap(record => record.screenshot ? [record.screenshot] : []))],
  };
  if (result === "passed") return { classification: "passed", reason: "All required proof was satisfied.", evidence };
  if (result === "agent_protocol_error") return { classification: "agent_failure", reason: "The driver repeatedly violated the QA tool protocol.", evidence };
  if (["harness_failure", "provider_failure", "reviewer_protocol_error"].includes(result)) {
    return { classification: "harness_failure", reason: errors[0] ?? `The run stopped with ${result}.`, evidence };
  }
  if (result === "verification_failed") {
    const pageError = proofs.some(proof => proof.proof.type === "no_application_errors" && !proof.passed &&
      "observed" in proof && Array.isArray(proof.observed) && proof.observed.some(error => typeof error === "string" && error.startsWith("pageerror:")));
    if (pageError) return { classification: "product_failure", reason: "The application raised an uncaught page error during the required workflow.", evidence };
    return { classification: "inconclusive", reason: "Proof was not satisfied; available evidence does not establish whether the application or driver caused it.", evidence };
  }
  return { classification: "inconclusive", reason: errors[0] ?? `Execution stopped with ${result} before proof could be verified.`, evidence };
}
