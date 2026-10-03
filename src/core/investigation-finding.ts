import type { RecordedEvidence } from "./evidence";
import { object } from "./scenario";

export type FindingCitation = { claim: "observed" | "cause" | "alternative" } & (
  | { kind: "diagnostic"; id: string }
  | { kind: "step"; sequence: number }
  | { kind: "observation"; sequence: number; start: number; end: number }
  | { kind: "screenshot"; id: string; file?: string }
  | { kind: "proof" | "error"; index: number });
export interface InvestigationFinding {
  expected: string;
  observed: string;
  cause: string | null;
  alternativeExplanation: string;
  alternativeAssessment: string;
  unknowns: string[];
  neededEvidence: string[];
  citations: FindingCitation[];
}
export const findingSchema = { type: "object", properties: {
  expected: { type: "string" }, observed: { type: "string" }, cause: { type: ["string", "null"] },
  alternativeExplanation: { type: "string" }, alternativeAssessment: { type: "string" },
  unknowns: { type: "array", items: { type: "string" } }, neededEvidence: { type: "array", items: { type: "string" } },
  citations: { type: "array", items: { oneOf: [
    { type: "object", properties: { claim: { enum: ["observed", "cause", "alternative"] }, kind: { const: "diagnostic" }, id: { type: "string" } }, required: ["claim", "kind", "id"] },
    { type: "object", properties: { claim: { enum: ["observed", "cause", "alternative"] }, kind: { const: "step" }, sequence: { type: "integer" } }, required: ["claim", "kind", "sequence"] },
    { type: "object", properties: { claim: { enum: ["observed", "cause", "alternative"] }, kind: { const: "observation" }, sequence: { type: "integer" }, start: { type: "integer" }, end: { type: "integer" } }, required: ["claim", "kind", "sequence", "start", "end"] },
    { type: "object", properties: { claim: { enum: ["observed", "cause", "alternative"] }, kind: { const: "screenshot" }, id: { type: "string" } }, required: ["claim", "kind", "id"] },
    { type: "object", properties: { claim: { enum: ["observed", "cause", "alternative"] }, kind: { enum: ["proof", "error"] }, index: { type: "integer" } }, required: ["claim", "kind", "index"] },
  ] } },
}, required: ["expected", "observed", "cause", "alternativeExplanation", "alternativeAssessment", "unknowns", "neededEvidence", "citations"] };

export function validateFinding(value: unknown, classification: string, access: RecordedEvidence, proofs: number, errors: number, options: { attributionRubric?: boolean } = {}): InvestigationFinding {
  const invalid = () => { throw new Error("Invalid finding or uninspected supporting citation"); };
  if (!object(value)) return invalid();
  for (const key of ["expected", "observed", "alternativeExplanation", "alternativeAssessment"]) if (typeof value[key] !== "string" || !value[key].trim()) invalid();
  for (const key of ["unknowns", "neededEvidence"]) if (!Array.isArray(value[key]) || value[key].some((item: unknown) => typeof item !== "string" || !item.trim())) invalid();
  if (classification === "inconclusive" ? value.cause !== null || !(value.unknowns as unknown[]).length : typeof value.cause !== "string" || !value.cause.trim()) invalid();
  if (!Array.isArray(value.citations)) return invalid();
  const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);
  const citations = value.citations.map((citation: unknown): FindingCitation => {
    if (!object(citation) || !["observed", "cause", "alternative"].includes(String(citation.claim))) return invalid();
    switch (citation.kind) {
      case "diagnostic": if (typeof citation.id !== "string" || !access.readDiagnostics.has(citation.id)) invalid(); break;
      case "step": if (!integer(citation.sequence) || !access.readSteps.has(citation.sequence)) invalid(); break;
      case "observation":
        if (!integer(citation.sequence) || !integer(citation.start) || !integer(citation.end) || citation.start < 0 || citation.end <= citation.start ||
          !access.observationRanges.get(citation.sequence)?.some(range => range.start <= Number(citation.start) && range.end >= Number(citation.end))) invalid(); break;
      case "screenshot": {
        if (typeof citation.id !== "string" || !access.viewedIds.has(citation.id)) return invalid();
        return { claim: citation.claim as FindingCitation["claim"], kind: "screenshot", id: citation.id, file: access.screenshots.find(entry => entry.id === citation.id)!.path };
      }
      case "proof": case "error": if (!integer(citation.index) || citation.index < 0 || citation.index >= (citation.kind === "proof" ? proofs : errors)) invalid(); break;
      default: return invalid();
    }
    return citation as FindingCitation;
  });
  if (classification !== "inconclusive" && !citations.some(c => c.claim === "cause" && (classification !== "product_failure" || c.kind !== "proof"))) invalid();
  if (options.attributionRubric) {
    if (classification === "inconclusive") {
      if (!(value.neededEvidence as unknown[]).length) throw new Error("Inconclusive finding must identify distinguishing evidence needed");
    } else {
      if (!citations.some(c => c.claim === "observed")) throw new Error("Attributed finding must cite observed behavior");
      if (!citations.some(c => c.claim === "cause" && c.kind !== "proof")) throw new Error("Attributed cause requires content beyond proof results");
      if (!citations.some(c => c.claim === "alternative" && c.kind !== "proof")) throw new Error("Attributed finding must cite evidence assessing the alternative");
    }
  }
  return { ...value, citations } as unknown as InvestigationFinding;
}
