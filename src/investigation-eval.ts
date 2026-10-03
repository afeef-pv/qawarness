import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { diagnoseRun } from "./core/diagnosis";
import { RecordedEvidence } from "./core/evidence";
import { investigateRecordedFailure, loadRecordedRun } from "./core/investigator";
import type { ExecutionRecord } from "./core/recorder";
import type { RunReport } from "./core/runner";
import type { RunInvestigation } from "./core/investigator";
import type { LLMProvider } from "./core/llm/provider";
import { createLLMProvider, createInvestigationProvider } from "./llm/create-provider";

interface Case { id: string; split: "development" | "held-out"; directory: string; expected: { classification: string; requiredClaim: string; supportingSteps: number[]; unsupportedClaims: string[] } }
const contained = async (root: string, path: string) => {
  const actual = await realpath(path), rel = relative(root, actual);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Fixture path escapes its directory");
  return actual;
};
export async function evaluateInvestigations(manifestPath: string, provider: LLMProvider, options: { trials: number; outputRoot?: string; comparisonProvider?: LLMProvider; compareAttributionRubric?: boolean; maxTurns?: number; maxDurationMs?: number }) {
  if (options.compareAttributionRubric && (options.comparisonProvider || options.maxTurns !== undefined || options.maxDurationMs !== undefined)) throw new Error("Compare the attribution rubric independently of reviewer settings and budgets");
  if (!Number.isSafeInteger(options.trials) || options.trials < 1 || options.trials > 20) throw new Error("Trials must be 1–20");
  if (options.maxTurns !== undefined && (!Number.isSafeInteger(options.maxTurns) || options.maxTurns < 1 || options.maxTurns > 100)) throw new Error("Invalid investigation turn budget");
  if (options.maxDurationMs !== undefined && (!Number.isSafeInteger(options.maxDurationMs) || options.maxDurationMs < 1 || options.maxDurationMs > 600000)) throw new Error("Invalid investigation duration budget");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.cases) || !manifest.cases.length) throw new Error("Invalid benchmark manifest");
  const root = await realpath(dirname(resolve(manifestPath)));
  // Preflight the entire corpus before making any external model requests.
  const cases: { entry: Case; directory: string; report: RunReport; history: ExecutionRecord[]; fingerprint: string }[] = [];
  const ids = new Set<string>();
  for (const entry of manifest.cases as Case[]) {
    if (!/^[a-z0-9-]+$/.test(entry.id) || ids.has(entry.id) || !["development", "held-out"].includes(entry.split) ||
      !["product_failure", "agent_failure", "harness_failure", "inconclusive"].includes(entry.expected?.classification) ||
      typeof entry.expected.requiredClaim !== "string" || !Array.isArray(entry.expected.supportingSteps) || !Array.isArray(entry.expected.unsupportedClaims)) throw new Error("Invalid benchmark case");
    ids.add(entry.id);
    const directory = await contained(root, resolve(root, entry.directory));
    const { report, history: recordedHistory } = await loadRecordedRun(directory);
    const history = recordedHistory.map(({ sequence, action, startedAt, durationMs, status, error, evidenceError, screenshot, beforeScreenshot, observation, inspection }) => ({ sequence, action, startedAt, durationMs, status, error, evidenceError, screenshot, beforeScreenshot, observation, inspection }));
    for (const record of history) {
      for (const key of ["screenshot", "beforeScreenshot"] as const) if (record[key]) record[key] = await contained(directory, resolve(directory, record[key]!));
      if (record.observation?.screenshot) record.observation.screenshot = await contained(directory, resolve(directory, record.observation.screenshot));
    }
    // Whitelist input fields: labels, notes, previous diagnoses and investigations cannot leak.
    const input = { runId: report.runId, scenario: { name: report.scenario.name, startUrl: report.scenario.startUrl, instruction: report.scenario.instruction, proof: report.scenario.proof, maxSteps: report.scenario.maxSteps, maxDuration: report.scenario.maxDuration }, result: report.result, execution: report.execution, verification: report.verification,
      proofResults: report.proofResults, errors: report.errors, initialObservation: report.initialObservation, finalObservation: report.finalObservation };
    const clean = { ...input, diagnosis: diagnoseRun(report.result, report.proofResults, history, report.errors) } as typeof report;
    const hash = new Bun.CryptoHasher("sha256").update(JSON.stringify(input)).update(await readFile(join(directory, "actions.jsonl")));
    const evidence = new RecordedEvidence({ directory, instruction: report.scenario.instruction, history, screenshot: join(directory, "final.png") });
    const files = [...new Set(evidence.screenshots.map(image => image.path))];
    // final.png is required unless the fixture explicitly declares its absence.
    if ((entry as Case & { missingFinalImage?: boolean }).missingFinalImage === true) files.splice(files.indexOf(join(directory, "final.png")), 1);
    for (const file of files) hash.update(await readFile(await contained(directory, file)));
    cases.push({ entry, directory, report: clean, history, fingerprint: hash.digest("hex") });
  }
  const destination = join(options.outputRoot ?? "runs/investigation-evals", crypto.randomUUID());
  await mkdir(destination, { recursive: true });
  const promptFingerprint = new Bun.CryptoHasher("sha256").update(await readFile(new URL("./core/investigator.ts", import.meta.url))).update(await readFile(new URL("./core/investigation-finding.ts", import.meta.url))).update(await readFile(new URL("./core/evidence.ts", import.meta.url))).update(await readFile(new URL("./core/investigation-timeline.ts", import.meta.url))).update(await readFile(new URL("./core/investigation-rubric.ts", import.meta.url))).digest("hex");
  const results: { caseId: string; split: string; contract: string; trial: number; fingerprint: string; originalRunId: string; expected: Case["expected"]; investigation: RunInvestigation; latencyMs: number; modelCalls: number; usage: { inputTokens: number; outputTokens: number } | null; cost: null; classificationCorrect: boolean | null; falseProductClaim: boolean; claimSupportReview: string }[] = [];
  for (const item of cases) for (const contract of ["baseline", "structured"] as const) for (let trial = 1; trial <= options.trials; trial++) {
    const path = join(destination, `${item.entry.id}-${contract}-${trial}`);
    await mkdir(path);
    let calls = 0, inputTokens = 0, outputTokens = 0, usageAvailable = true;
    const chosen = contract === "structured" ? options.comparisonProvider ?? provider : provider;
    const measured: LLMProvider = { name: chosen.name, settings: chosen.settings, async generate(request) {
      calls++;
      const response = await chosen.generate(request);
      if (response.usage?.inputTokens === undefined || response.usage.outputTokens === undefined) usageAvailable = false;
      inputTokens += response.usage?.inputTokens ?? 0; outputTokens += response.usage?.outputTokens ?? 0;
      return response;
    } };
    const start = performance.now();
    const investigation = await investigateRecordedFailure(item.report, item.history, item.directory, measured, { maxTurns: contract === "structured" ? options.maxTurns : undefined, maxDurationMs: contract === "structured" ? options.maxDurationMs : undefined, legacyContract: contract === "baseline" && !options.comparisonProvider && !options.compareAttributionRubric, attributionRubric: options.compareAttributionRubric ? contract === "structured" : undefined, transcript: join(path, "review.jsonl") });
    const result = { caseId: item.entry.id, split: item.entry.split, contract, trial, fingerprint: item.fingerprint,
      originalRunId: item.report.runId, expected: item.entry.expected, investigation, latencyMs: performance.now() - start, modelCalls: calls,
      usage: usageAvailable ? { inputTokens, outputTokens } : null, cost: null,
      classificationCorrect: investigation.status === "completed" ? investigation.diagnosis?.classification === item.entry.expected.classification : null,
      falseProductClaim: investigation.diagnosis?.classification === "product_failure" && item.entry.expected.classification !== "product_failure",
      claimSupportReview: "manual_review_required" };
    await writeFile(join(path, "attempt.json"), JSON.stringify({ ...result, promptFingerprint, settings: investigation.attempt, pricingAssumptions: null }, null, 2), { flag: "wx" });
    results.push(result);
  }
  const aggregate = ["baseline", "structured"].flatMap(contract => ["development", "held-out"].map(split => {
    const rows = results.filter(r => r.contract === contract && r.split === split), completed = rows.filter(r => r.investigation.status === "completed");
    return { contract, split, attempted: rows.length, completed: completed.length, failed: rows.length - completed.length,
      budgetExhausted: rows.filter(r => /budget|time limit/.test(r.investigation.error ?? "")).length,
      totalLatencyMs: rows.reduce((sum, r) => sum + r.latencyMs, 0), modelCalls: rows.reduce((sum, r) => sum + r.modelCalls, 0),
      usage: rows.every(r => r.usage !== null) ? { inputTokens: rows.reduce((sum, r) => sum + r.usage!.inputTokens, 0), outputTokens: rows.reduce((sum, r) => sum + r.usage!.outputTokens, 0) } : null, cost: null,
      correctClassification: completed.filter(r => r.classificationCorrect).length, falseProductClaims: rows.filter(r => r.falseProductClaim).length,
      nonProductTrials: rows.filter(r => r.expected.classification !== "product_failure").length,
      appropriateAbstentions: completed.filter(r => r.expected.classification === "inconclusive" && r.investigation.diagnosis?.classification === "inconclusive").length,
      inconclusiveTrials: rows.filter(r => r.expected.classification === "inconclusive").length,
      repeatability: cases.filter(c => c.entry.split === split).map(c => { const trials = rows.filter(r => r.caseId === c.entry.id); return { caseId: c.entry.id, classifications: trials.map(t => t.investigation.diagnosis?.classification ?? "failed"), causes: trials.map(t => t.investigation.finding?.cause ?? t.investigation.diagnosis?.reason ?? null) }; }),
      unsupportedExplanations: null, supportingClaimAccuracy: null, manualReviewRequired: true };
  }));
  const summary = { schemaVersion: 1, destination, provider: provider.name, temperature: 0, maxTurns: 12, maxDurationMs: 60000,
    comparison: options.compareAttributionRubric ? "attribution_rubric" : options.comparisonProvider ? "reviewer_settings" : "output_contract",
    promptFingerprint, aggregate, results };
  await writeFile(join(destination, "summary.json"), JSON.stringify(summary, null, 2), { flag: "wx" });
  return summary;
}
if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2), manifest = args.shift();
    if (!manifest) throw new Error("Usage: bun run investigation:eval manifest.json --trials 3 --json (explicit live model run)");
    let trials = 3, json = false, compare = false, compareAttributionRubric = false, maxTurns: number | undefined, maxDurationMs: number | undefined;
    while (args.length) { const flag = args.shift(); if (flag === "--trials") trials = Number(args.shift()); else if (flag === "--json") json = true; else if (flag === "--compare-reviewer") compare = true; else if (flag === "--compare-attribution-rubric") compareAttributionRubric = true; else if (flag === "--max-turns") maxTurns = Number(args.shift()); else if (flag === "--max-duration-ms") maxDurationMs = Number(args.shift()); else throw new Error(`Unknown option ${flag}`); }
    const result = await evaluateInvestigations(manifest, createLLMProvider(), { trials, compareAttributionRubric, comparisonProvider: compare ? createInvestigationProvider() : undefined, maxTurns, maxDurationMs });
    console.log(json ? JSON.stringify(result) : `Evaluation: ${result.destination}\n${JSON.stringify(result.aggregate, null, 2)}`);
  } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 2; }
}
