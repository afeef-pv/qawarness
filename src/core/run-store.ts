import { createHash } from "node:crypto";
import type { ExecutionRecord } from "./recorder";
import type { QAScenario } from "./scenario";
import type { RunReport, RunStatus } from "./runner";

export interface ScenarioDefinitionRecord extends QAScenario {
  id: string;
  version: number;
  contentHash: string;
  createdAt: Date;
  source?: { type: "file"; path: string };
}
export interface RunRecord {
  id: string;
  scenario: { definitionId: string; name: string; version: number };
  scenarioSnapshot: Omit<QAScenario, "name">;
  status: "running" | "interrupted" | RunStatus;
  startedAt: Date;
  heartbeatAt?: Date;
  finishedAt?: Date;
  agent: { provider: string; model: string };
  environment: { platform: string; backend: string; startUrl: string };
  stepCount: number;
  context?: RunReport["context"];
  execution?: RunReport["execution"];
  verification?: RunReport["verification"];
  diagnosis?: RunReport["diagnosis"];
  limits?: RunReport["limits"];
  completion?: { reason?: string };
  proofResults?: RunReport["proofResults"];
  initialObservation?: RunReport["initialObservation"];
  finalObservation?: RunReport["finalObservation"];
  errors?: string[];
  artifacts?: RunReport["artifacts"];
}
export interface RunStepRecord extends ExecutionRecord {
  id: string;
  runId: string;
  finishedAt: Date;
}
export interface RunStore {
  saveScenarioDefinition(scenario: QAScenario, source?: ScenarioDefinitionRecord["source"]): Promise<ScenarioDefinitionRecord>;
  createRun(run: RunRecord): Promise<void>;
  heartbeatRun(runId: string): Promise<void>;
  appendStep(runId: string, record: ExecutionRecord): Promise<void>;
  finishRun(runId: string, report: RunReport): Promise<void>;
}

export function scenarioContentHash(scenario: QAScenario): string {
  return createHash("sha256").update(JSON.stringify({ name: scenario.name, description: scenario.description, startUrl: scenario.startUrl, instruction: scenario.instruction, proof: scenario.proof, maxSteps: scenario.maxSteps, maxDuration: scenario.maxDuration })).digest("hex");
}

export function redactScenario(scenario: QAScenario): QAScenario {
  const redact = (text: string) => text.replace(/(password|passcode|secret|api[_ -]?key)(\s*[:=]\s*)([^\s]+)/gi, "$1$2[redacted]");
  return { ...scenario, ...(scenario.description ? { description: redact(scenario.description) } : {}), instruction: redact(scenario.instruction) };
}
