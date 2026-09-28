import { scenarioContentHash } from "./run-store";
import type { QAScenario } from "./scenario";
import type { RunReport } from "./runner";
import type { DiagnosisClassification } from "./diagnosis";

export interface RepeatSummary {
  scenario: { name: string; contentHash: string };
  applicationRevision: string;
  fixture: string;
  agent: RunReport["agent"];
  context: RunReport["context"];
  runs: { runId: string; result: RunReport["result"]; diagnosis: DiagnosisClassification; steps: number; durationMs: number }[];
  passRate: number;
  averageSteps: number;
  averageDurationMs: number;
  diagnosisCounts: Record<DiagnosisClassification, number>;
}

export async function repeatScenario(
  scenario: QAScenario,
  count: number,
  reset: () => Promise<void>,
  run: (index: number) => Promise<RunReport>,
): Promise<RepeatSummary> {
  if (!Number.isSafeInteger(count) || count < 1 || count > 20) throw new Error("Repeat count must be between 1 and 20");
  const reports: RunReport[] = [];
  let group: string | undefined;
  const expectedScenarioHash = scenarioContentHash(scenario);
  for (let index = 0; index < count; index++) {
    await reset();
    const report = await run(index);
    if (report.scenarioContentHash !== expectedScenarioHash) throw new Error("Repeated run used a different scenario definition");
    if (!report.context.applicationRevision || !report.context.fixture) throw new Error("Repeated runs require an application revision and fixture identity");
    const identity = JSON.stringify({ scenario: report.scenarioContentHash, agent: report.agent, context: report.context });
    if (group !== undefined && identity !== group) throw new Error("Repeated runs do not share the same scenario, application, fixture, model, and environment context");
    group = identity;
    reports.push(report);
  }
  const first = reports[0]!;
  const runs = reports.map(report => ({ runId: report.runId, result: report.result, diagnosis: report.diagnosis.classification, steps: report.steps,
    durationMs: new Date(report.finishedAt).getTime() - new Date(report.startedAt).getTime() }));
  const diagnosisCounts: RepeatSummary["diagnosisCounts"] = { passed: 0, product_failure: 0, agent_failure: 0, harness_failure: 0, inconclusive: 0 };
  for (const item of runs) diagnosisCounts[item.diagnosis]++;
  return { scenario: { name: scenario.name, contentHash: expectedScenarioHash }, applicationRevision: first.context.applicationRevision!, fixture: first.context.fixture!,
    agent: first.agent, context: first.context, runs, passRate: diagnosisCounts.passed / runs.length,
    averageSteps: runs.reduce((sum, item) => sum + item.steps, 0) / runs.length,
    averageDurationMs: runs.reduce((sum, item) => sum + item.durationMs, 0) / runs.length, diagnosisCounts };
}
