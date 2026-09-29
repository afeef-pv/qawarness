import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { scenarioContentHash } from "./core/run-store";
import { loadScenario, parseDurationMs } from "./core/scenario";
import { runQa } from "./qa";
import { runRepeat } from "./repeat";

type LocalReport = {
  runId: string;
  scenario: { name: string };
  result: string;
  startedAt: string;
  finishedAt?: string;
  steps?: number;
  diagnosis?: { classification: string };
  [key: string]: unknown;
};

const rootHelp = `qawarness — local agentic QA

Usage: bun run qawarness <command> [options]

Commands:
  run <scenario.yaml>       Run one scenario
  repeat <scenario.yaml>    Run comparable attempts with a fixture reset
  validate <scenario.yaml>  Check a scenario without starting a browser or model
  runs list                 List local completed runs
  runs show <run-id>        Show a local run report

Run "bun run qawarness <command> --help" for command options.
Other scripts: bun run dashboard, bun run db:init, bun run smoke, bun run llm:smoke.`;

const help: Record<string, string> = {
  run: `Usage: bun run qawarness run <scenario.yaml> [--headed]

Runs one scenario. Exit 0 on pass, 1 on a completed non-passing run, 2 on a command or setup error.
  --headed  Show the Chromium window`,
  repeat: `Usage: bun run qawarness repeat <scenario.yaml> --count <1..20> --reset-url <url> --app-revision <revision> --fixture <id> [--headed]

Resets the app before every attempt. The reset URL must share the scenario origin.
QA_APP_REVISION and QA_FIXTURE may supply the corresponding flags.
Exit 0 when every attempt passes, 1 on completed non-passing runs, 2 on a command or setup error.`,
  validate: `Usage: bun run qawarness validate <scenario.yaml> [--json]

Checks a scenario and prints its name, effective limits, proof count, and content hash.`,
  runs: `Usage: bun run qawarness runs <list|show> [options]

Commands:
  list [--limit <1..100>] [--json]  List local completed reports (default: 20)
  show <run-id> [--json]          Show one local report`,
};

class UsageError extends Error {}

function parse(args: string[], flags: Record<string, "boolean" | "value">): { positional: string[]; options: Record<string, string | boolean> } {
  const positional: string[] = [];
  const options: Record<string, string | boolean> = {};
  let afterSeparator = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--" && !afterSeparator) { afterSeparator = true; continue; }
    if (!arg.startsWith("--") || afterSeparator) { positional.push(arg); continue; }
    const equals = arg.indexOf("=");
    const name = equals < 0 ? arg : arg.slice(0, equals);
    const kind = flags[name];
    if (!kind) throw new UsageError(`Unknown option ${name}`);
    if (name in options) throw new UsageError(`Option ${name} was provided twice`);
    if (kind === "boolean") {
      if (equals >= 0) throw new UsageError(`Option ${name} does not take a value`);
      options[name] = true;
    } else {
      const value = equals >= 0 ? arg.slice(equals + 1) : args[++index];
      if (!value || value.startsWith("--")) throw new UsageError(`Option ${name} needs a value`);
      options[name] = value;
    }
  }
  return { positional, options };
}

function onePath(positional: string[], label: string): string {
  if (positional.length !== 1 || !positional[0]) throw new UsageError(`Expected one ${label}`);
  return positional[0];
}

function display(report: LocalReport): string {
  return `Run: ${report.runId}\nScenario: ${report.scenario.name}\nResult: ${report.result}\nDiagnosis: ${report.diagnosis?.classification ?? "unavailable"}\nSteps: ${report.steps ?? "unknown"}\nStarted: ${report.startedAt}\nFinished: ${report.finishedAt ?? "unknown"}\nArtifacts: runs/${report.runId}`;
}

function isLocalReport(value: unknown): value is LocalReport {
  if (typeof value !== "object" || value === null) return false;
  const report = value as Record<string, unknown>;
  return typeof report.runId === "string" && typeof report.result === "string" &&
    typeof report.startedAt === "string" &&
    typeof report.scenario === "object" && report.scenario !== null &&
    typeof (report.scenario as Record<string, unknown>).name === "string";
}

async function reports(): Promise<LocalReport[]> {
  const entries = await readdir("runs", { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const results = await Promise.all(entries.filter(entry => entry.isDirectory()).map(async entry => {
    try {
      const report: unknown = JSON.parse(await readFile(join("runs", entry.name, "report.json"), "utf8"));
      if (isLocalReport(report)) return report;
      console.error(`Skipping unreadable report: runs/${entry.name}/report.json`);
      return undefined;
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (error instanceof SyntaxError) {
        console.error(`Skipping unreadable report: runs/${entry.name}/report.json`);
        return undefined;
      }
      throw error;
    }
  }));
  return results.filter((report): report is LocalReport => report !== undefined).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function main(args: string[]): Promise<number> {
  const command = args[0];
  if (!command || command === "--help" || command === "help") {
    const topic = command === "help" ? args[1] : undefined;
    if (topic && !help[topic]) { console.error(`Unknown command ${topic}`); return 2; }
    console.log(topic ? help[topic] : rootHelp);
    return 0;
  }
  if (!(command in help)) {
    console.error(`Unknown command ${command}\n\n${rootHelp}`);
    return 2;
  }
  if (args.slice(1).includes("--help")) {
    console.log(help[command]);
    return 0;
  }
  try {
    switch (command) {
      case "run": {
        const { positional, options } = parse(args.slice(1), { "--headed": "boolean" });
        return await runQa(onePath(positional, "scenario path"), options["--headed"] === true);
      }
      case "repeat": {
        const { positional, options } = parse(args.slice(1), { "--count": "value", "--reset-url": "value", "--app-revision": "value", "--fixture": "value", "--headed": "boolean" });
        const scenarioPath = onePath(positional, "scenario path");
        const countText = options["--count"];
        const count = Number(countText);
        if (typeof countText !== "string" || !/^\d+$/.test(countText) || !Number.isSafeInteger(count) || count < 1 || count > 20) throw new UsageError("--count must be an integer from 1 to 20");
        const resetUrl = options["--reset-url"];
        const applicationRevision = options["--app-revision"] ?? Bun.env.QA_APP_REVISION;
        const fixture = options["--fixture"] ?? Bun.env.QA_FIXTURE;
        if (typeof resetUrl !== "string" || !resetUrl) throw new UsageError("--reset-url is required");
        if (typeof applicationRevision !== "string" || !applicationRevision.trim()) throw new UsageError("--app-revision or QA_APP_REVISION is required");
        if (typeof fixture !== "string" || !fixture.trim()) throw new UsageError("--fixture or QA_FIXTURE is required");
        return await runRepeat({ scenarioPath, count, resetUrl, applicationRevision, fixture, headed: options["--headed"] === true });
      }
      case "validate": {
        const { positional, options } = parse(args.slice(1), { "--json": "boolean" });
        const path = onePath(positional, "scenario path");
        const scenario = await loadScenario(path);
        const result = { path, name: scenario.name, startUrl: scenario.startUrl, proofCount: scenario.proof.length,
          maxSteps: Math.min(scenario.maxSteps, 200), maxDurationMs: Math.min(scenario.maxDuration ? parseDurationMs(scenario.maxDuration) : 90 * 60_000, 90 * 60_000),
          contentHash: scenarioContentHash(scenario) };
        console.log(options["--json"] ? JSON.stringify(result) : `Valid: ${result.name}\nProofs: ${result.proofCount}\nLimits: ${result.maxSteps} steps, ${result.maxDurationMs} ms\nContent hash: ${result.contentHash}`);
        return 0;
      }
      case "runs": {
        const action = args[1];
        if (action === "list") {
          const { positional, options } = parse(args.slice(2), { "--limit": "value", "--json": "boolean" });
          if (positional.length) throw new UsageError("runs list takes no positional arguments");
          const limitText = options["--limit"];
          const limit = limitText === undefined ? 20 : Number(limitText);
          if ((limitText !== undefined && (typeof limitText !== "string" || !/^\d+$/.test(limitText))) ||
            !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new UsageError("--limit must be an integer from 1 to 100");
          const items = (await reports()).slice(0, limit).map(report => ({ runId: report.runId, scenario: report.scenario.name,
            result: report.result, diagnosis: report.diagnosis?.classification ?? "unavailable", startedAt: report.startedAt }));
          console.log(options["--json"] ? JSON.stringify(items) : items.length ? items.map(item => `${item.startedAt}  ${item.result.padEnd(19)}  ${item.scenario}  ${item.runId}`).join("\n") : "No local completed runs.");
          return 0;
        }
        if (action === "show") {
          const { positional, options } = parse(args.slice(2), { "--json": "boolean" });
          const id = onePath(positional, "run ID");
          if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) throw new UsageError("Invalid run ID");
          let report: LocalReport;
          try {
            const value: unknown = JSON.parse(await readFile(join("runs", id, "report.json"), "utf8"));
            if (!isLocalReport(value)) throw new UsageError(`Invalid local report for ${id}`);
            report = value;
          }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new UsageError(`No local report for ${id}`);
            throw error;
          }
          console.log(options["--json"] ? JSON.stringify(report) : display(report));
          return 0;
        }
        throw new UsageError("Expected runs list or runs show <run-id>");
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    if (error instanceof UsageError) console.error(`\n${help[command]}`);
    return 2;
  }
  return 2;
}

if (import.meta.main) process.exitCode = await main(Bun.argv.slice(2));
