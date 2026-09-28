import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runAgent } from "./agent";
import { QAExecutor } from "./executor";
import type { QAEnvironment, QAObservation } from "./environment";
import { LLMError, type LLMProvider } from "./llm/provider";
import { JsonlRecorder } from "./recorder";
import type { ExecutionRecord } from "./recorder";
import { reviewJudgeProof } from "./reviewer";
import { parseDurationMs, type QAScenario } from "./scenario";
import { redactScenario, type RunStore } from "./run-store";
import { verifyProof, type ProofResult } from "./verifier";
export type RunStatus = "passed" | "verification_failed" | "max_steps" | "max_duration" | "stalled" | "agent_protocol_error" | "reviewer_protocol_error" | "provider_failure" | "harness_failure";
export interface RunReport { runId: string; scenario: QAScenario; limits: { maxSteps: number; maxDurationMs: number }; startedAt: string; finishedAt: string; result: RunStatus; steps: number; completionReason?: string; proofResults: ProofResult[]; finalObservation?: QAObservation; errors: string[]; artifacts: Record<string, string> }
export interface RunOptions { store?: RunStore; source?: { type: "file"; path: string }; agentModel?: string; backend?: string }
export async function runScenario(scenario: QAScenario, provider: LLMProvider, environment: QAEnvironment, runDirectory: string, options: RunOptions = {}): Promise<RunReport> {
  const limits = { maxSteps: Math.min(scenario.maxSteps, 200), maxDurationMs: Math.min(scenario.maxDuration ? parseDurationMs(scenario.maxDuration) : 90 * 60_000, 90 * 60_000) };
  const runId = runDirectory.split("/").at(-1) ?? runDirectory;
  const artifacts = { actions: join(runDirectory, "actions.jsonl"), report: join(runDirectory, "report.json"), observation: join(runDirectory, "final-observation.json"), screenshot: join(runDirectory, "final.png"), trace: join(runDirectory, "trace.zip") };
  const safeScenario = redactScenario(scenario);
  const report: RunReport = { runId, scenario: safeScenario, limits, startedAt: new Date().toISOString(), finishedAt: "", result: "harness_failure", steps: 0, proofResults: [], errors: [], artifacts };
  if (options.store) {
    try {
      const definition = await options.store.saveScenarioDefinition(scenario, options.source);
      await options.store.createRun({ id: runId, scenario: { definitionId: definition.id, name: scenario.name, version: definition.version }, scenarioSnapshot: {
        startUrl: safeScenario.startUrl, instruction: safeScenario.instruction, proof: safeScenario.proof, maxSteps: safeScenario.maxSteps,
        ...(safeScenario.maxDuration ? { maxDuration: safeScenario.maxDuration } : {}),
      }, status: "running", startedAt: new Date(report.startedAt), agent: { provider: provider.name, model: options.agentModel ?? "unknown" },
        environment: { platform: "web", backend: options.backend ?? "unknown", startUrl: scenario.startUrl }, stepCount: 0, limits, artifacts });
    } catch (error) { throw new Error("MongoDB run initialization failed", { cause: error }); }
  }
  let executionError: unknown;
  let persistenceError: unknown;
  let recordedSteps = 0;
  let reviewing = false;
  let screenshotCaptured = false;
  const history: ExecutionRecord[] = [];
  const controller = new AbortController();
  const durationTimer = setTimeout(() => controller.abort(), limits.maxDurationMs);
  try {
    await mkdir(runDirectory, { recursive: true });
    await writeFile(artifacts.actions, "");
    await environment.start();
    await environment.navigate(scenario.startUrl);
    const result = await runAgent(scenario, environment, provider, new QAExecutor(environment, new JsonlRecorder(artifacts.actions),
      async record => {
        recordedSteps = record.sequence;
        history.push(record);
        if (options.store) try { await options.store.appendStep(runId, record); } catch (error) {
          persistenceError = new Error("MongoDB step persistence failed", { cause: error });
          throw persistenceError;
        }
      }), { maxSteps: limits.maxSteps, signal: controller.signal });
    report.steps = result.steps;
    report.completionReason = result.completionReason;
    if (result.stopReason) report.errors.push(result.stopReason);
    report.result = result.status === "done" ? "verification_failed" : result.status;
    if (controller.signal.aborted) report.result = "max_duration";
    if (result.status === "done" && !controller.signal.aborted) {
      if (scenario.proof.some(proof => proof.type === "judge")) {
        await environment.screenshot(artifacts.screenshot);
        screenshotCaptured = true;
      }
      const observation = await environment.observe();
      const deterministic = await verifyProof(scenario.proof.filter(proof => proof.type !== "judge"), environment, observation);
      if (controller.signal.aborted) throw new Error("Run exceeded its duration limit");
      const deterministicResults = deterministic.results[Symbol.iterator]();
      for (const proof of scenario.proof) {
        if (proof.type === "judge") reviewing = true;
        report.proofResults.push(proof.type === "judge"
          ? await reviewJudgeProof(proof, scenario.instruction, observation, history, provider, controller.signal, artifacts.screenshot)
          : deterministicResults.next().value!);
        if (controller.signal.aborted) throw new Error("Run exceeded its duration limit");
        reviewing = false;
      }
      report.result = report.proofResults.every(proof => proof.passed) ? "passed" : "verification_failed";
    }
    if (report.result === "max_duration") report.errors.push("Run exceeded its duration limit");
  } catch (error) {
    executionError = error;
    report.steps = recordedSteps;
    report.errors.push(controller.signal.aborted ? "Run exceeded its duration limit" : error instanceof Error ? error.message : String(error));
    report.result = controller.signal.aborted ? "max_duration"
      : reviewing && error instanceof LLMError && error.kind === "malformed_response" ? "reviewer_protocol_error"
      : error instanceof LLMError ? "provider_failure" : "harness_failure";
  } finally {
    clearTimeout(durationTimer);
    if (!screenshotCaptured) try { await environment.screenshot(artifacts.screenshot); } catch (error) { report.errors.push(`screenshot: ${String(error)}`); }
    try { report.finalObservation = await environment.observe(); await writeFile(artifacts.observation, JSON.stringify(report.finalObservation, null, 2)); } catch (error) { report.errors.push(`observation: ${String(error)}`); }
    try { await environment.close(); } catch (error) { report.errors.push(`close: ${String(error)}`); }
    report.finishedAt = new Date().toISOString();
    if (report.finalObservation) report.errors.push(...report.finalObservation.errors);
    try { await writeFile(artifacts.report, JSON.stringify(report, null, 2)); } catch (error) { executionError ??= error; }
    if (options.store) {
      try { await options.store.finishRun(runId, report); } catch (error) {
        persistenceError ??= new Error("MongoDB run finalization failed", { cause: error });
      }
    }
  }
  if (persistenceError) throw persistenceError;
  if (executionError && !report.errors.length) throw executionError;
  return report;
}
