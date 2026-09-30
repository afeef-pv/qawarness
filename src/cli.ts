import { mkdir, readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { scenarioContentHash } from "./core/run-store";
import { loadScenario, parseDurationMs } from "./core/scenario";
import { defineScenario, definitionPath } from "./definitions";
import { runQa } from "./qa";
import { runRepeat } from "./repeat";
import { investigateRecordedFailure, loadRecordedRun, saveInvestigation } from "./core/investigator";
import { createLLMProvider } from "./llm/create-provider";

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
  define                    Save a versioned test definition from plain text
  run <scenario.yaml|name>  Run one scenario
  repeat <scenario.yaml|name> Run comparable attempts with a fixture reset
  validate <scenario.yaml|name> Check a scenario without starting a browser or model
  runs list                 List local completed runs
  runs show <run-id>        Show a local run report
  runs investigate <run-id> Investigate a recorded failure without running the app

Run "bun run qawarness <command> --help" for command options.
Other scripts: bun run dashboard, bun run db:init, bun run smoke, bun run llm:smoke.`;

const help: Record<string, string> = {
  define: `Usage: bun run qawarness define --name <name> [--description <text>] [--start-url <url>] [--instruction <text>] [--proof <text>] [--json]

The first version needs all five fields. Later versions carry forward omitted fields.
Each version is a runnable scenarios/<name>/vN.yaml file. A plain-text proof uses
the independent judge verifier. Names use letters, numbers, underscores, or hyphens.`,
  run: `Usage: bun run qawarness run <scenario.yaml|name> [--headed]

Runs one scenario. Exit 0 on pass, 1 on a completed non-passing run, 2 on a command or setup error.
  --headed  Show the Chromium window`,
  repeat: `Usage: bun run qawarness repeat <scenario.yaml|name> --count <1..20> --reset-url <url> --app-revision <revision> --fixture <id> [--headed]

Resets the app before every attempt. The reset URL must share the scenario origin.
QA_APP_REVISION and QA_FIXTURE may supply the corresponding flags.
Exit 0 when every attempt passes, 1 on completed non-passing runs, 2 on a command or setup error.`,
  validate: `Usage: bun run qawarness validate <scenario.yaml|name> [--json]

Checks a scenario and prints its name, effective limits, proof count, and content hash.`,
  runs: `Usage: bun run qawarness runs <list|show|investigate> [options]

Commands:
  list [--limit <1..100>] [--json]  List local completed reports (default: 20)
  show <run-id> [--json]          Show one local report
  investigate <run-id> [--json]   Review a recorded failure using the configured model

Investigation writes a separate artifact; the original report stays unchanged.
Exit 0 when investigation completes (including inconclusive), 1 if review fails, 2 on invalid input/setup.`,
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

async function scenarioPath(positional: string[]): Promise<string> {
  const value = onePath(positional, "scenario path or definition name");
  return /\.ya?ml$/.test(value) || value.includes("/") || value.includes("\\") ? value : definitionPath(value);
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
      case "define": {
        const { positional, options } = parse(args.slice(1), { "--name": "value", "--description": "value", "--start-url": "value", "--instruction": "value", "--proof": "value", "--json": "boolean" });
        if (positional.length) throw new UsageError("define takes flags, not positional arguments");
        const name = options["--name"];
        if (typeof name !== "string") throw new UsageError("--name is required");
        const defined = await defineScenario({ name,
          ...(typeof options["--description"] === "string" ? { description: options["--description"] } : {}),
          ...(typeof options["--start-url"] === "string" ? { startUrl: options["--start-url"] } : {}),
          ...(typeof options["--instruction"] === "string" ? { instruction: options["--instruction"] } : {}),
          ...(typeof options["--proof"] === "string" ? { proof: options["--proof"] } : {}),
        });
        const result = { name, ...defined };
        console.log(options["--json"] ? JSON.stringify(result) : `Defined: ${name} v${defined.version}\nPath: ${defined.path}`);
        return 0;
      }
      case "run": {
        const { positional, options } = parse(args.slice(1), { "--headed": "boolean" });
        return await runQa(await scenarioPath(positional), options["--headed"] === true);
      }
      case "repeat": {
        const { positional, options } = parse(args.slice(1), { "--count": "value", "--reset-url": "value", "--app-revision": "value", "--fixture": "value", "--headed": "boolean" });
        const selected = await scenarioPath(positional);
        const countText = options["--count"];
        const count = Number(countText);
        if (typeof countText !== "string" || !/^\d+$/.test(countText) || !Number.isSafeInteger(count) || count < 1 || count > 20) throw new UsageError("--count must be an integer from 1 to 20");
        const resetUrl = options["--reset-url"];
        const applicationRevision = options["--app-revision"] ?? Bun.env.QA_APP_REVISION;
        const fixture = options["--fixture"] ?? Bun.env.QA_FIXTURE;
        if (typeof resetUrl !== "string" || !resetUrl) throw new UsageError("--reset-url is required");
        if (typeof applicationRevision !== "string" || !applicationRevision.trim()) throw new UsageError("--app-revision or QA_APP_REVISION is required");
        if (typeof fixture !== "string" || !fixture.trim()) throw new UsageError("--fixture or QA_FIXTURE is required");
        return await runRepeat({ scenarioPath: selected, count, resetUrl, applicationRevision, fixture, headed: options["--headed"] === true });
      }
      case "validate": {
        const { positional, options } = parse(args.slice(1), { "--json": "boolean" });
        const path = await scenarioPath(positional);
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
        if (action === "investigate") {
          const { positional, options } = parse(args.slice(2), { "--json": "boolean" });
          const id = onePath(positional, "run ID");
          if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) throw new UsageError("Invalid run ID");
          const root = await realpath("runs");
          const directory = await realpath(join(root, id));
          const within = relative(root, directory);
          if (within.startsWith("..") || isAbsolute(within)) throw new UsageError("Run directory is outside local runs");
          const { report, history } = await loadRecordedRun(directory);
          if (report.runId !== id) throw new UsageError("Recorded run ID does not match its directory");
          if (report.result === "passed") throw new UsageError("Only non-passing runs can be investigated");
          const provider = createLLMProvider();
          const destination = join(directory, "investigations", crypto.randomUUID());
          await mkdir(destination, { recursive: true });
          const investigation = await investigateRecordedFailure(report, history, directory, provider, { transcript: join(destination, "review.jsonl") });
          const path = join(destination, "investigation.json");
          await saveInvestigation(path, investigation);
          console.log(options["--json"] ? JSON.stringify({ runId: id, path, ...investigation }) : `Run: ${id}\nInvestigation: ${investigation.status}\nDiagnosis: ${investigation.diagnosis?.classification ?? "unavailable"}\nReason: ${investigation.diagnosis?.reason ?? investigation.error}\nArtifact: ${path}`);
          return investigation.status === "completed" ? 0 : 1;
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
        throw new UsageError("Expected runs list, runs show <run-id>, or runs investigate <run-id>");
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
