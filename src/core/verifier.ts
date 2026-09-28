import type { QAEnvironment, QAObservation } from "./environment";
import type { QAProof } from "./scenario";
export type DeterministicProof = Exclude<QAProof, { type: "judge" }>;
export type ProofResult = { proof: DeterministicProof; passed: boolean; observed: unknown }
  | { proof: Extract<QAProof, { type: "judge" }>; passed: boolean; status: "satisfied" | "not_satisfied" | "inconclusive"; reason: string; reviewer: { provider: string; model: string }; evidence: { screenshot?: string; stepSequences: number[] } };
export async function verifyProof(proofs: DeterministicProof[], environment: QAEnvironment, observation: QAObservation): Promise<{ passed: boolean; results: ProofResult[] }> {
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
    }
    results.push({ proof, observed, passed });
  }
  return { passed: results.every(r => r.passed), results };
}
