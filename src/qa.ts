import { join } from "node:path";
import { loadScenario } from "./core/scenario";
import { runScenario } from "./core/runner";
import { PlaywrightEnvironment } from "./environments/playwright";
import { createLLMProvider } from "./llm/create-provider";
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
  const report = await runScenario(scenario, provider, new PlaywrightEnvironment({ headed: args.includes("--headed"), tracePath: join(directory, "trace.zip") }), directory);
  console.log(`Scenario: ${scenario.name}\nResult: ${report.result.toUpperCase()}\nSteps: ${report.steps}\nArtifacts: ${directory}`);
  for (const proof of report.proofResults.filter(p => !p.passed)) console.log(`Failed proof: ${JSON.stringify(proof.proof)}`);
  if (report.errors.length && report.result !== "passed") console.error(report.errors[0]);
  process.exitCode = report.result === "passed" ? 0 : 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
