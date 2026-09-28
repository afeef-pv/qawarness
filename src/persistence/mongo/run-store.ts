import type { Db } from "mongodb";
import { MongoServerError } from "mongodb";
import type { ExecutionRecord } from "../../core/recorder";
import { redactScenario, scenarioContentHash, type RunRecord, type RunStepRecord, type RunStore, type ScenarioDefinitionRecord } from "../../core/run-store";
import type { QAScenario } from "../../core/scenario";
import type { RunReport } from "../../core/runner";

export class MongoRunStore implements RunStore {
  constructor(private readonly db: Db) {}

  async ensureIndexes(): Promise<void> {
    await this.db.collection("scenario_definitions").createIndex({ name: 1, version: -1 }, { unique: true });
    await this.db.collection("scenario_definitions").createIndex({ name: 1, contentHash: 1 }, { unique: true });
    await this.db.collection("runs").createIndex({ "scenario.name": 1, startedAt: -1 });
    await this.db.collection("runs").createIndex({ status: 1, startedAt: -1 });
    await this.db.collection("run_steps").createIndex({ runId: 1, sequence: 1 }, { unique: true });
  }

  async saveScenarioDefinition(scenario: QAScenario, source?: ScenarioDefinitionRecord["source"]): Promise<ScenarioDefinitionRecord> {
    const collection = this.db.collection<ScenarioDefinitionRecord & { _id: string }>("scenario_definitions");
    const contentHash = scenarioContentHash(scenario);
    for (;;) {
      const existing = await collection.findOne({ name: scenario.name, contentHash });
      if (existing) return { ...existing, id: existing._id };
      const latest = await collection.find({ name: scenario.name }).sort({ version: -1 }).limit(1).next();
      const version = (latest?.version ?? 0) + 1;
      const record = { ...redactScenario(scenario), id: `${scenario.name}:${version}`, _id: `${scenario.name}:${version}`, version, contentHash, createdAt: new Date(), ...(source ? { source } : {}) };
      try {
        await collection.insertOne(record);
        return record;
      } catch (error) {
        if (error instanceof MongoServerError && error.code === 11000) continue;
        throw error;
      }
    }
  }

  async createRun(run: RunRecord): Promise<void> {
    await this.db.collection<RunRecord & { _id: string }>("runs").insertOne({ ...run, _id: run.id });
  }

  async appendStep(runId: string, record: ExecutionRecord): Promise<void> {
    const step: RunStepRecord = { ...record, id: `${runId}:${record.sequence}`, runId, finishedAt: new Date(new Date(record.startedAt).getTime() + record.durationMs) };
    await this.db.collection<RunStepRecord & { _id: string }>("run_steps").insertOne({ ...step, _id: step.id });
    await this.db.collection<RunRecord & { _id: string }>("runs").updateOne({ _id: runId }, { $max: { stepCount: record.sequence } });
  }

  async finishRun(runId: string, report: RunReport): Promise<void> {
    const result = await this.db.collection<RunRecord & { _id: string }>("runs").updateOne({ _id: runId, status: "running" }, { $set: {
      status: report.result, finishedAt: new Date(report.finishedAt), stepCount: report.steps,
      execution: report.execution, verification: report.verification, diagnosis: report.diagnosis,
      context: report.context,
      completion: { reason: report.completionReason }, proofResults: report.proofResults,
      initialObservation: report.initialObservation, finalObservation: report.finalObservation, errors: report.errors, artifacts: report.artifacts,
    } });
    if (result.matchedCount !== 1) throw new Error(`Run ${runId} could not be finalized`);
  }

  async getRun(runId: string) { return this.db.collection<RunRecord & { _id: string }>("runs").findOne({ _id: runId }); }
  async getRunSteps(runId: string) { return this.db.collection("run_steps").find({ runId }).sort({ sequence: 1 }).toArray(); }
  async getRunStep(runId: string, sequence: number) { return this.db.collection("run_steps").findOne({ runId, sequence }); }
  async getLatestRunStep(runId: string) { return this.db.collection("run_steps").find({ runId }).sort({ sequence: -1 }).limit(1).next(); }
  async getLatestRunsForScenario(name: string, limit = 10) { return this.db.collection("runs").find({ "scenario.name": name }).sort({ startedAt: -1 }).limit(limit).toArray(); }
  async listRuns(limit = 100) { return this.db.collection<RunRecord & { _id: string }>("runs").find({}).sort({ startedAt: -1 }).limit(limit).toArray(); }
  async getScenarioDefinition(id: string) { return this.db.collection<ScenarioDefinitionRecord & { _id: string }>("scenario_definitions").findOne({ _id: id }); }
}
