import type { QAEnvironment, QAObservation } from "./environment";
import type { QAProof } from "./scenario";
export interface ProofResult { proof: QAProof; passed: boolean; observed: unknown }
export async function verifyProof(proofs: QAProof[], environment: QAEnvironment, observation: QAObservation): Promise<{ passed: boolean; results: ProofResult[] }> {
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
