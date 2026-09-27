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
  observation?: QAObservation;
  inspection?: { count: number; elements: import("./environment").QAElement[] };
}

export class JsonlRecorder {
  constructor(private readonly path: string) {}

  async append(record: ExecutionRecord): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(record)}\n`);
  }
}
