import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cli = resolve("src/cli.ts");

async function invoke(args: string[], cwd = process.cwd()) {
  const child = Bun.spawn(["bun", "run", cli, ...args], {
    cwd, env: { ...process.env, DEEPSEEK_API_KEY: "", MONGODB_URI: "" },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, exit };
}

test("CLI help and validation work without a model or database", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qawarness-cli-"));
  try {
    const scenarioPath = join(directory, "check.yaml");
    await writeFile(scenarioPath, "name: check\nstartUrl: http://localhost:3000/\ninstruction: Check the page\nproof:\n  - type: text_visible\n    text: ready\n");
    const help = await invoke(["--help"]);
    expect(help.exit).toBe(0);
    expect(help.stdout).toContain("validate <scenario.yaml>");
    const validated = await invoke(["validate", scenarioPath, "--json"]);
    expect(validated.exit).toBe(0);
    expect(JSON.parse(validated.stdout)).toMatchObject({ name: "check", proofCount: 1, maxSteps: 30, maxDurationMs: 5_400_000 });
    const invalid = await invoke(["validate", join(directory, "missing.yaml")]);
    expect(invalid.exit).toBe(2);
    expect(invalid.stderr).toContain("ENOENT");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI rejects bad options before starting a run", async () => {
  const unknown = await invoke(["run", "scenario.yaml", "--typo"]);
  expect(unknown.exit).toBe(2);
  expect(unknown.stderr).toContain("Unknown option --typo");
  const count = await invoke(["repeat", "scenario.yaml", "--count", "21"]);
  expect(count.exit).toBe(2);
  expect(count.stderr).toContain("--count must be an integer from 1 to 20");
  const help = await invoke(["repeat", "--help"]);
  expect(help.exit).toBe(0);
  expect(help.stdout).toContain("--reset-url");
});

test("CLI lists and shows local completed reports", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qawarness-cli-runs-"));
  try {
    const id = "run-123";
    await mkdir(join(directory, "runs", id), { recursive: true });
    await writeFile(join(directory, "runs", id, "report.json"), JSON.stringify({
      runId: id, scenario: { name: "checkout" }, result: "passed",
      diagnosis: { classification: "passed" }, steps: 3,
      startedAt: "2026-09-29T00:00:00.000Z", finishedAt: "2026-09-29T00:01:00.000Z",
    }));
    await mkdir(join(directory, "runs", "older"));
    await writeFile(join(directory, "runs", "older", "report.json"), JSON.stringify({
      runId: "older", scenario: { name: "legacy" }, result: "passed", startedAt: "2026-09-28T00:00:00.000Z",
    }));
    await mkdir(join(directory, "runs", "partial"));
    await writeFile(join(directory, "runs", "partial", "report.json"), "{");
    const list = await invoke(["runs", "list", "--json"], directory);
    expect(list.exit).toBe(0);
    expect(JSON.parse(list.stdout)).toMatchObject([{ runId: id, result: "passed" }, { runId: "older", diagnosis: "unavailable" }]);
    expect(list.stderr).toContain("Skipping unreadable report");
    const show = await invoke(["runs", "show", id], directory);
    expect(show.exit).toBe(0);
    expect(show.stdout).toContain("Scenario: checkout");
    const escaped = await invoke(["runs", "show", "../outside"], directory);
    expect(escaped.exit).toBe(2);
    expect(escaped.stderr).toContain("Invalid run ID");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
