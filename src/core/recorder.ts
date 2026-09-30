import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { QAExecutionAction } from "./actions";
import type { QAObservation } from "./environment";

export interface ExecutionRecord {
  sequence: number;
  action: QAExecutionAction;
  startedAt: string;
  durationMs: number;
  status: "succeeded" | "failed" | "done";
  error?: string;
  evidenceError?: string;
  screenshot?: string;
  beforeScreenshot?: string;
  observation?: QAObservation;
  inspection?: { count: number; elements: import("./environment").QAElement[] };
}

export function redactRecord(record: ExecutionRecord): ExecutionRecord {
  if (record.action.type !== "fill") return record;
  const target = record.action.target;
  const label = Object.values(target).join(" ");
  if (!/(password|passcode|secret|token|api.?key)/i.test(label)) return record;
  const value = record.action.value;
  const scrub = (text: string) => value ? text.replaceAll(value, "[redacted]") : text;
  return {
    ...record,
    action: { ...record.action, value: "[redacted]" },
    ...(record.error ? { error: scrub(record.error) } : {}),
    ...(record.evidenceError ? { evidenceError: scrub(record.evidenceError) } : {}),
    ...(record.observation ? { observation: {
      ...record.observation,
      text: scrub(record.observation.text),
      errors: record.observation.errors.map(scrub),
      elements: record.observation.elements.map(element => ({ ...element,
        ...(element.text ? { text: scrub(element.text) } : {}),
        ...(element.value ? { value: scrub(element.value) } : {}),
      })),
    } } : {}),
  };
}

export class JsonlRecorder {
  constructor(private readonly path: string) {}

  async append(record: ExecutionRecord): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(record)}\n`);
  }
}
