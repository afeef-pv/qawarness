import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    expect(help.stdout).toContain("validate <scenario.yaml|name>");
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

test("define saves plain text as immutable, runnable scenario versions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qawarness-cli-define-"));
  try {
    const missing = await invoke(["define", "--name", "sign-in"], directory);
    expect(missing.exit).toBe(2);
    expect(missing.stderr).toContain("A new definition needs");
    const first = await invoke(["define", "--name", "sign-in", "--description", "Sign in",
      "--start-url", "http://localhost:3000/sign-in", "--instruction", "Enter credentials and sign in",
      "--proof", "Dashboard: signed in", "--json"], directory);
    expect(first.exit).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({ name: "sign-in", version: 1, path: "scenarios/sign-in/v1.yaml" });
    const firstPath = join(directory, "scenarios", "sign-in", "v1.yaml");
    const firstYaml = await readFile(firstPath, "utf8");
    expect(firstYaml).toContain("description: Sign in");
    expect(firstYaml).toContain("type: judge");
    expect(firstYaml).toContain("Dashboard: signed in");
    const validated = await invoke(["validate", "sign-in", "--json"], directory);
    expect(validated.exit).toBe(0);
    expect(JSON.parse(validated.stdout)).toMatchObject({ name: "sign-in", proofCount: 1, path: "scenarios/sign-in/v1.yaml" });
    const unchanged = await invoke(["define", "--name", "sign-in", "--proof", "Dashboard: signed in"], directory);
    expect(unchanged.exit).toBe(2);
    expect(unchanged.stderr).toContain("unchanged");
    const second = await invoke(["define", "--name", "sign-in", "--proof", "Account menu is visible", "--json"], directory);
    expect(second.exit).toBe(0);
    expect(JSON.parse(second.stdout)).toMatchObject({ version: 2, path: "scenarios/sign-in/v2.yaml" });
    expect(await readFile(firstPath, "utf8")).toBe(firstYaml);
    const secondYaml = await readFile(join(directory, "scenarios", "sign-in", "v2.yaml"), "utf8");
    expect(secondYaml).toContain("instruction: Enter credentials and sign in");
    expect(secondYaml).toContain("description: Sign in");
    const latest = await invoke(["validate", "sign-in", "--json"], directory);
    expect(JSON.parse(latest.stdout)).toMatchObject({ path: "scenarios/sign-in/v2.yaml" });
    expect(JSON.parse(latest.stdout).contentHash).not.toBe(JSON.parse(validated.stdout).contentHash);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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

test("CLI investigates an old failure through recorded evidence and preserves its original report", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qawarness-cli-investigate-"));
  let requests = 0, unavailable = false;
  const model = Bun.serve({ port: 0, async fetch(request) {
    requests++;
    if (unavailable) return Response.json({ error: { message: "Offline" } }, { status: 503 });
    const body = await request.json() as { tools: { function: { name: string } }[]; messages: { role: string }[] };
    expect(body.tools.map(tool => tool.function.name)).toContain("read_steps");
    expect(body.tools.map(tool => tool.function.name)).not.toContain("click");
    const read = !body.messages.some(message => message.role === "tool");
    return Response.json({ model: "fake-reviewer", choices: [{ message: { content: null, tool_calls: [{ id: String(requests), type: "function", function: {
      name: read ? "read_steps" : "finish_investigation", arguments: JSON.stringify(read ? { from: 1, count: 1 } : { classification: "agent_failure", reason: "Step 1 stopped without saving", proofIndexes: [0], errorIndexes: [] }),
    } }] } }] });
  } });
  try {
    const id = "old-failure", run = join(directory, "runs", id);
    await mkdir(run, { recursive: true });
    const original = JSON.stringify({ runId: id, result: "verification_failed", startedAt: "2026-09-01T00:00:00Z", finishedAt: "2026-09-01T00:01:00Z",
      scenario: { name: "save", startUrl: "http://localhost/", instruction: "Save", maxSteps: 30, proof: [{ type: "text_visible", text: "Saved" }] },
      proofResults: [{ proof: { type: "text_visible", text: "Saved" }, passed: false, observed: false }], errors: [] });
    await writeFile(join(run, "report.json"), original);
    await writeFile(join(run, "actions.jsonl"), JSON.stringify({ sequence: 1, action: { type: "done", reason: "Saved" }, status: "done", durationMs: 1, startedAt: "2026-09-01T00:00:00Z" }) + "\n");
    await writeFile(join(run, "final.png"), "image bytes");
    const invokeReview = async () => {
      const child = Bun.spawn(["bun", "run", cli, "runs", "investigate", id, "--json"], { cwd: directory,
        env: { ...process.env, DEEPSEEK_API_KEY: "fake-key", DEEPSEEK_BASE_URL: `http://127.0.0.1:${model.port}`, MONGODB_URI: "" }, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(stderr).toBe("");
      return { value: JSON.parse(stdout), exit };
    };
    const first = await invokeReview();
    expect(first.exit).toBe(0);
    expect(first.value).toMatchObject({ status: "completed", diagnosis: { classification: "agent_failure", evidence: { stepSequences: [1] } }, reviewer: { model: "fake-reviewer" } });
    expect(JSON.parse(await readFile(first.value.path, "utf8"))).toMatchObject({ status: "completed" });
    expect(await readFile(join(run, "report.json"), "utf8")).toBe(original);
    unavailable = true;
    const second = await invokeReview();
    expect(second.exit).toBe(1);
    expect(second.value.status).toBe("failed");
    expect(second.value.path).not.toBe(first.value.path);
    expect(await readFile(join(run, "report.json"), "utf8")).toBe(original);
    expect((await invoke(["runs", "investigate", "../outside"], directory)).exit).toBe(2);
  } finally { model.stop(true); await rm(directory, { recursive: true, force: true }); }
});
