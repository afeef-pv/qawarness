import { join } from "node:path";
import { loadScenario } from "./core/scenario";
import { runScenario } from "./core/runner";
import { PlaywrightEnvironment } from "./environments/playwright";
import { createLLMProvider } from "./llm/create-provider";
import { connectMongoRunStore } from "./persistence/mongo/client";
import { harnessRevision } from "./run-context";
const args = Bun.argv.slice(2);
if (!args[0] || args.some((arg, i) => i > 0 && arg !== "--headed")) {
  console.error("Usage: bun run qa <scenario.yaml> [--headed]");
  process.exit(2);
}
try {
  const scenario = await loadScenario(args[0]);
  const provider = createLLMProvider();
  const runId = `${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}-${scenario.name.replace(/[^a-zA-Z0-9_-]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`;
  const directory = join("runs", runId);
  const mongo = Bun.env.MONGODB_URI ? await connectMongoRunStore(Bun.env.MONGODB_URI, Bun.env.MONGODB_DB || "qawarness") : undefined;
  try {
    const report = await runScenario(scenario, provider, new PlaywrightEnvironment({ headed: args.includes("--headed"), tracePath: join(directory, "trace.zip") }), directory,
      { store: mongo?.store, source: { type: "file", path: args[0] }, agentModel: Bun.env.DEEPSEEK_MODEL || "deepseek-flash", backend: "playwright",
        context: { applicationRevision: Bun.env.QA_APP_REVISION, fixture: Bun.env.QA_FIXTURE, harnessRevision: harnessRevision() } });
    console.log(`Scenario: ${scenario.name}\nRun: ${runId}\nResult: ${report.result.toUpperCase()}\nDiagnosis: ${report.diagnosis.classification}\nSteps: ${report.steps}\nArtifacts: ${directory}\nPersistence: ${mongo ? "MongoDB" : "filesystem"}`);
    for (const proof of report.proofResults.filter(p => !p.passed)) console.log(`Failed proof: ${JSON.stringify(proof.proof)}${"reason" in proof ? ` — ${proof.status}: ${proof.reason}` : ""}`);
    if (report.errors.length && report.result !== "passed") console.error(report.errors[0]);
    process.exitCode = report.result === "passed" ? 0 : 1;
  } finally { await mongo?.client.close(); }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
