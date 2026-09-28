import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { repeatScenario } from "./core/repeat";
import { runScenario } from "./core/runner";
import { loadScenario } from "./core/scenario";
import { PlaywrightEnvironment } from "./environments/playwright";
import { createLLMProvider } from "./llm/create-provider";
import { connectMongoRunStore } from "./persistence/mongo/client";
import { harnessRevision } from "./run-context";

if (import.meta.main) {
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
    const provider = createLLMProvider();
    const mongo = Bun.env.MONGODB_URI ? await connectMongoRunStore(Bun.env.MONGODB_URI, Bun.env.MONGODB_DB || "qawarness") : undefined;
    const groupId = `${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}-${crypto.randomUUID().slice(0, 8)}`;
    try {
      const summary = await repeatScenario(scenario, count, async () => {
        const response = await fetch(reset, { method: "POST", signal: AbortSignal.timeout(20_000) });
        if (!response.ok) throw new Error(`Fixture reset failed with HTTP ${response.status}`);
      }, async index => {
        const runId = `${groupId}-${String(index + 1).padStart(2, "0")}`;
        const directory = join("runs", runId);
        return runScenario(scenario, provider, new PlaywrightEnvironment({ headed, tracePath: join(directory, "trace.zip") }), directory,
          { store: mongo?.store, source: { type: "file", path: scenarioPath }, agentModel: Bun.env.DEEPSEEK_MODEL || "deepseek-flash", backend: "playwright",
            context: { applicationRevision, fixture, harnessRevision: harnessRevision() } });
      });
      await mkdir("runs", { recursive: true });
      const summaryPath = join("runs", `repeat-${groupId}.json`);
      await writeFile(summaryPath, JSON.stringify(summary, null, 2));
      console.log(`Scenario: ${summary.scenario.name}\nRuns: ${summary.runs.length}\nPass rate: ${(summary.passRate * 100).toFixed(1)}%\nAverage steps: ${summary.averageSteps.toFixed(1)}\nDiagnoses: ${JSON.stringify(summary.diagnosisCounts)}\nSummary: ${summaryPath}`);
      if (summary.passRate < 1) process.exitCode = 1;
    } finally { await mongo?.client.close(); }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
