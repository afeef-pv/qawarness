import type { QAEnvironment, QAObservation } from "./environment";
import type { QAProof } from "./scenario";
import type { ExecutionRecord } from "./recorder";
export type DeterministicProof = Exclude<QAProof, { type: "judge" }>;
export type ProofResult = { proof: DeterministicProof; passed: boolean; observed: unknown }
  | { proof: Extract<QAProof, { type: "judge" }>; passed: boolean; status: "satisfied" | "not_satisfied" | "inconclusive"; reason: string; reviewer: { provider: string; model: string }; evidence: { screenshot?: string; stepSequences: number[] } };
export async function verifyProof(proofs: DeterministicProof[], environment: QAEnvironment, observation: QAObservation,
  history: ExecutionRecord[] = [], initialObservation?: QAObservation): Promise<{ passed: boolean; results: ProofResult[] }> {
  const results: ProofResult[] = [];
  for (const proof of proofs) {
    let observed: unknown;
    let passed = false;
    switch (proof.type) {
      case "url_equals": observed = observation.location.url; passed = observed === proof.value; break;
      case "url_contains": observed = observation.location.url; passed = typeof observed === "string" && observed.includes(proof.value); break;
      case "text_visible": case "text_not_visible": {
        const visible = observation.text.includes(proof.text);
        observed = visible;
        passed = proof.type === "text_visible" ? visible : !visible;
        break;
      }
      case "element_visible": case "element_not_visible": {
        const match = await environment.inspect(proof.target);
        const visible = match.elements.filter(e => e.visible).length;
        observed = visible;
        passed = proof.type === "element_visible" ? visible > 0 : visible === 0;
        break;
      }
      case "element_text": case "element_value": {
        const match = await environment.inspect(proof.target);
        const values = match.elements.map(e => proof.type === "element_text" ? e.text : e.value);
        observed = values;
        passed = match.count === 1 && values[0] === proof.equals;
        break;
      }
      case "text_visible_after_click": {
        let before = initialObservation;
        let matchedStep: number | undefined;
        let appearedAtStep: number | undefined;
        for (const [index, record] of history.entries()) {
          if (record.status === "succeeded" && record.action.type === "click" &&
              JSON.stringify(record.action.target) === JSON.stringify(proof.target) &&
              before && !before.text.includes(proof.text)) {
            const appearance = history.slice(index).find(step => step.observation?.text.includes(proof.text));
            if (appearance) {
              matchedStep = record.sequence;
              appearedAtStep = appearance.sequence;
              break;
            }
          }
          if (record.observation) before = record.observation;
        }
        observed = { matchedStep, appearedAtStep, finalVisible: observation.text.includes(proof.text) };
        passed = matchedStep !== undefined && observation.text.includes(proof.text);
        break;
      }
      case "no_application_errors": {
        const errors = [...(initialObservation?.errors ?? []), ...history.flatMap(record => record.observation?.errors ?? []), ...observation.errors];
        observed = [...new Set(errors)];
        passed = errors.length === 0;
        break;
      }
    }
    results.push({ proof, observed, passed });
  }
  return { passed: results.every(r => r.passed), results };
}
