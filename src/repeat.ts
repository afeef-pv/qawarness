import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { repeatScenario } from "./core/repeat";
import { runScenario } from "./core/runner";
import { loadScenario } from "./core/scenario";
import { scenarioContentHash } from "./core/run-store";
import { PlaywrightEnvironment } from "./environments/playwright";
import { createLLMProvider } from "./llm/create-provider";
import { connectMongoRunStore } from "./persistence/mongo/client";
import { harnessRevision } from "./run-context";

if (import.meta.main) {
  let manifestPath: string | undefined;
  const args = Bun.argv.slice(2);
  const scenarioPath = args.shift();
  let count = 0;
  let resetUrl = "";
  let applicationRevision = Bun.env.QA_APP_REVISION ?? "";
  let fixture = Bun.env.QA_FIXTURE ?? "";
  let headed = false;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--headed") { headed = true; continue; }
    const value = args[++index];
    if (!value) { console.error(`Missing value for ${flag}`); process.exit(2); }
    switch (flag) {
      case "--count": count = Number(value); break;
      case "--reset-url": resetUrl = value; break;
      case "--app-revision": applicationRevision = value; break;
      case "--fixture": fixture = value; break;
      default: console.error(`Unknown flag: ${flag}`); process.exit(2);
    }
  }
  if (!scenarioPath || !Number.isSafeInteger(count) || count < 1 || count > 20 || !resetUrl || !applicationRevision.trim() || !fixture.trim()) {
    console.error("Usage: bun run qa:repeat <scenario.yaml> --count <1..20> --reset-url <url> --app-revision <revision> --fixture <id> [--headed]");
    process.exit(2);
  }
  try {
    const scenario = await loadScenario(scenarioPath);
    const reset = new URL(resetUrl);
    if (reset.origin !== new URL(scenario.startUrl).origin || !["http:", "https:"].includes(reset.protocol)) throw new Error("Reset URL must share the scenario start URL origin");
    const groupId = `${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}-${crypto.randomUUID().slice(0, 8)}`;
    await mkdir("runs", { recursive: true });
    const manifest = join("runs", `repeat-${groupId}.jsonl`);
    manifestPath = manifest;
    const record = (event: Record<string, unknown>) => appendFile(manifest, `${JSON.stringify({ ...event, at: new Date().toISOString() })}\n`);
    await writeFile(manifest, `${JSON.stringify({ type: "group_started", groupId, count, scenario: { name: scenario.name, contentHash: scenarioContentHash(scenario) }, applicationRevision, fixture, at: new Date().toISOString() })}\n`);
    const runIdFor = (index: number) => `${groupId}-${String(index + 1).padStart(2, "0")}`;
    let mongo: Awaited<ReturnType<typeof connectMongoRunStore>> | undefined;
    try {
      const provider = createLLMProvider();
      mongo = Bun.env.MONGODB_URI ? await connectMongoRunStore(Bun.env.MONGODB_URI, Bun.env.MONGODB_DB || "qawarness") : undefined;
      const summary = await repeatScenario(scenario, count, async index => {
        const runId = runIdFor(index);
        await record({ type: "attempt_started", attempt: index + 1, runId });
        try {
          const response = await fetch(reset, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fixture }), signal: AbortSignal.timeout(20_000) });
          if (!response.ok) throw new Error(`Fixture reset failed with HTTP ${response.status}`);
          let confirmation: unknown;
          try { confirmation = await response.json(); } catch { throw new Error("Fixture reset must return JSON with fixture and applicationRevision"); }
          if (!confirmation || typeof confirmation !== "object" ||
            (confirmation as Record<string, unknown>).fixture !== fixture ||
            (confirmation as Record<string, unknown>).applicationRevision !== applicationRevision) {
            throw new Error(`Fixture reset did not confirm fixture ${fixture} and application revision ${applicationRevision}`);
          }
          await record({ type: "reset_completed", attempt: index + 1, runId });
        } catch (error) {
          await record({ type: "attempt_failed", attempt: index + 1, runId, phase: "reset", error: error instanceof Error ? error.message : String(error) });
          throw error;
        }
      }, async index => {
        const runId = runIdFor(index);
        const directory = join("runs", runId);
        await record({ type: "run_started", attempt: index + 1, runId });
        try {
          const report = await runScenario(scenario, provider, new PlaywrightEnvironment({ headed, tracePath: join(directory, "trace.zip") }), directory,
            { store: mongo?.store, source: { type: "file", path: scenarioPath }, agentModel: Bun.env.DEEPSEEK_MODEL || "deepseek-flash", backend: "playwright",
              context: { applicationRevision, fixture, harnessRevision: harnessRevision() } });
          await record({ type: "run_finished", attempt: index + 1, runId, result: report.result, diagnosis: report.diagnosis.classification });
          return report;
        } catch (error) {
          await record({ type: "attempt_failed", attempt: index + 1, runId, phase: "run", error: error instanceof Error ? error.message : String(error) });
          throw error;
        }
      });
      const summaryPath = join("runs", `repeat-${groupId}.json`);
      await writeFile(summaryPath, JSON.stringify(summary, null, 2));
      await record({ type: "group_finished", summary: summaryPath });
      console.log(`Scenario: ${summary.scenario.name}\nRuns: ${summary.runs.length}\nPass rate: ${(summary.passRate * 100).toFixed(1)}%\nAverage steps: ${summary.averageSteps.toFixed(1)}\nDiagnoses: ${JSON.stringify(summary.diagnosisCounts)}\nSummary: ${summaryPath}\nManifest: ${manifest}`);
      if (summary.passRate < 1) process.exitCode = 1;
    } catch (error) {
      await record({ type: "group_failed", error: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally { await mongo?.client.close(); }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    if (manifestPath) console.error(`Manifest: ${manifestPath}`);
    process.exitCode = 2;
  }
}
