import type { QAExecutionAction } from "./actions";
import type { QAEnvironment } from "./environment";
import type { ExecutionRecord, JsonlRecorder } from "./recorder";
import { redactRecord } from "./recorder";

export class QAExecutor {
  private sequence = 0;
  private completed = false;

  constructor(
    private readonly environment: QAEnvironment,
    private readonly recorder: JsonlRecorder,
    private readonly onStep?: (record: ExecutionRecord) => Promise<void>,
    private readonly captureEvidence?: (record: ExecutionRecord) => Promise<string>,
  ) {}

  async execute(action: QAExecutionAction): Promise<ExecutionRecord> {
    if (this.completed) {
      throw new Error("Execution is already done");
    }

    const startedAt = new Date().toISOString();
    const start = performance.now();
    const record: ExecutionRecord = {
      sequence: ++this.sequence,
      action,
      startedAt,
      durationMs: 0,
      status: "succeeded",
    };

    if (action.type === "done") {
      record.status = "done";
      this.completed = true;
      record.observation = await this.environment.observe();
    } else if (action.type === "wait") {
      await new Promise(resolve => setTimeout(resolve, action.milliseconds));
      record.observation = await this.environment.observe();
    } else if (action.type === "inspect") {
      try {
        record.inspection = await this.environment.inspect(action.target);
        record.observation = await this.environment.observe();
      } catch (error) {
        record.status = "failed";
        record.error = error instanceof Error ? error.message : String(error);
        try { record.observation = await this.environment.observe(); } catch { /* unavailable environment */ }
        record.durationMs = performance.now() - start;
        await this.record(record);
        if (!record.observation) throw error;
        return record;
      }
    } else {
      try {
        const outcome = await this.environment.act(action);
        if (outcome.success) {
          record.observation = await this.environment.observe();
        } else {
          record.status = "failed";
          record.error = outcome.error;
          try { record.observation = await this.environment.observe(); } catch { /* unavailable environment */ }
        }
      } catch (error) {
        record.status = "failed";
        record.error = error instanceof Error ? error.message : String(error);
        record.durationMs = performance.now() - start;
        await this.record(record);
        throw error;
      }
    }

    record.durationMs = performance.now() - start;
    await this.record(record);
    return record;
  }

  private async record(record: ExecutionRecord): Promise<void> {
    if (this.captureEvidence && (record.status === "failed" || record.status === "done")) {
      try { record.screenshot = await this.captureEvidence(record); }
      catch (error) { record.evidenceError = error instanceof Error ? error.message : String(error); }
    }
    const safe = redactRecord(record);
    await this.recorder.append(safe);
    await this.onStep?.(safe);
  }
}
