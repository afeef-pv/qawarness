import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runAgent } from "./agent";
import { QAExecutor } from "./executor";
import type { QAEnvironment, QAObservation } from "./environment";
import type { LLMProvider } from "./llm/provider";
import { JsonlRecorder } from "./recorder";
import type { QAScenario } from "./scenario";
import { verifyProof, type ProofResult } from "./verifier";
export type RunStatus = "passed" | "verification_failed" | "max_steps" | "agent_protocol_error" | "provider_failure" | "harness_failure";
export interface RunReport { runId: string; scenario: QAScenario; startedAt: string; finishedAt: string; result: RunStatus; steps: number; completionReason?: string; proofResults: ProofResult[]; finalObservation?: QAObservation; errors: string[]; artifacts: Record<string, string> }
export async function runScenario(scenario: QAScenario, provider: LLMProvider, environment: QAEnvironment, runDirectory: string): Promise<RunReport> {
  await mkdir(runDirectory, { recursive: true });
  const runId = runDirectory.split("/").at(-1) ?? runDirectory;
  const artifacts = { actions: join(runDirectory, "actions.jsonl"), report: join(runDirectory, "report.json"), observation: join(runDirectory, "final-observation.json"), screenshot: join(runDirectory, "final.png"), trace: join(runDirectory, "trace.zip") };
  await writeFile(artifacts.actions, "");
  const report: RunReport = { runId, scenario, startedAt: new Date().toISOString(), finishedAt: "", result: "harness_failure", steps: 0, proofResults: [], errors: [], artifacts };
  try {
    await environment.start();
    await environment.navigate(scenario.startUrl);
    const result = await runAgent(scenario, environment, provider, new QAExecutor(environment, new JsonlRecorder(artifacts.actions)));
    report.steps = result.steps;
    report.completionReason = result.completionReason;
    report.result = result.status === "done" ? "verification_failed" : result.status;
    if (result.status === "done") {
      const verified = await verifyProof(scenario.proof, environment, await environment.observe());
      report.proofResults = verified.results;
      report.result = verified.passed ? "passed" : "verification_failed";
    }
  } catch (error) {
    report.errors.push(error instanceof Error ? error.message : String(error));
    report.result = error instanceof Error && error.name === "LLMError" ? "provider_failure" : "harness_failure";
  } finally {
    try { await environment.screenshot(artifacts.screenshot); } catch (error) { report.errors.push(`screenshot: ${String(error)}`); }
    try { report.finalObservation = await environment.observe(); await writeFile(artifacts.observation, JSON.stringify(report.finalObservation, null, 2)); } catch (error) { report.errors.push(`observation: ${String(error)}`); }
    try { await environment.close(); } catch (error) { report.errors.push(`close: ${String(error)}`); }
    report.finishedAt = new Date().toISOString();
    if (report.finalObservation) report.errors.push(...report.finalObservation.errors);
    await writeFile(artifacts.report, JSON.stringify(report, null, 2));
  }
  return report;
}
