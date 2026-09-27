import { readFile } from "node:fs/promises";
import YAML from "yaml";
import type { SemanticTarget } from "./actions";

export type QAProof =
  | { type: "url_equals" | "url_contains"; value: string }
  | { type: "text_visible" | "text_not_visible"; text: string }
  | { type: "element_visible" | "element_not_visible"; target: SemanticTarget }
  | { type: "element_text" | "element_value"; target: SemanticTarget; equals: string }
  | { type: "judge"; text: string };
export interface QAScenario { name: string; startUrl: string; instruction: string; proof: QAProof[]; maxSteps: number; maxDuration?: string }
export const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string" && !!v.trim();
export function parseDurationMs(v: unknown): number {
  if (typeof v !== "string") throw new Error("maxDuration must be a duration such as 90m");
  const match = /^(\d+)(ms|s|m|h)$/.exec(v);
  const units: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
  const duration = match ? Number(match[1]) * units[match[2]!]! : NaN;
  if (!Number.isSafeInteger(duration) || duration < 1) throw new Error("maxDuration must be a positive duration such as 90m");
  return duration;
}
export function parseTarget(v: unknown): SemanticTarget {
  if (!object(v)) throw new Error("target must be an object");
  switch (v.by) {
    case "role": if (str(v.role) && (v.name === undefined || str(v.name))) return { by: "role", role: v.role, ...(v.name === undefined ? {} : { name: v.name as string }) }; break;
    case "label": if (str(v.label)) return { by: "label", label: v.label }; break;
    case "text": if (str(v.text)) return { by: "text", text: v.text }; break;
    case "testId": if (str(v.id)) return { by: "testId", id: v.id }; break;
    case "css": if (str(v.selector)) return { by: "css", selector: v.selector }; break;
  }
  throw new Error("invalid semantic target");
}
export function parseScenario(v: unknown): QAScenario {
  if (!object(v) || !str(v.name) || !str(v.startUrl) || !str(v.instruction) || !Array.isArray(v.proof) || !v.proof.length) throw new Error("scenario requires name, startUrl, instruction and nonempty proof");
  const url = new URL(v.startUrl);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("startUrl must be HTTP(S)");
  const maxSteps = v.maxSteps === undefined ? 30 : v.maxSteps;
  if (!Number.isSafeInteger(maxSteps) || (maxSteps as number) < 1) throw new Error("maxSteps must be a positive integer");
  if (v.maxDuration !== undefined) parseDurationMs(v.maxDuration);
  const proof = v.proof.map((p: unknown, i: number): QAProof => {
    if (!object(p)) throw new Error(`proof ${i + 1} must be an object`);
    switch (p.type) {
      case "url_equals": case "url_contains": if (str(p.value)) return { type: p.type, value: p.value }; break;
      case "text_visible": case "text_not_visible": if (str(p.text)) return { type: p.type, text: p.text }; break;
      case "judge": if (str(p.text)) return { type: "judge", text: p.text }; break;
      case "element_visible": case "element_not_visible": return { type: p.type, target: parseTarget(p.target) };
      case "element_text": case "element_value": if (typeof p.equals === "string") return { type: p.type, target: parseTarget(p.target), equals: p.equals }; break;
    }
    throw new Error(`invalid proof ${i + 1}`);
  });
  return { name: v.name, startUrl: v.startUrl, instruction: v.instruction, proof, maxSteps: maxSteps as number,
    ...(v.maxDuration === undefined ? {} : { maxDuration: v.maxDuration as string }) };
}
export async function loadScenario(path: string): Promise<QAScenario> { return parseScenario(YAML.parse(await readFile(path, "utf8"))); }
