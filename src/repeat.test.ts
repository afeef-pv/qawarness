import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("repeat CLI resets each run and writes a comparable summary", async () => {
  let saved = false;
  let resets = 0;
  const app = Bun.serve({ port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/reset" && request.method === "POST") {
      expect(await request.json()).toEqual({ fixture: "empty-store" });
      saved = false; resets++;
      return Response.json({ fixture: "empty-store", applicationRevision: "app-v1" });
    }
    if (url.pathname === "/save" && request.method === "POST") { saved = true; return Response.redirect(new URL("/", request.url), 303); }
    return new Response(`<form action="/save" method="post"><button>Save</button></form><p>${saved ? "Saved" : "Unsaved"}</p>`, { headers: { "content-type": "text/html" } });
  } });
  const model = Bun.serve({ port: 0, async fetch(request) {
    const body = await request.json() as { messages: { role: string }[] };
    const done = body.messages.some(message => message.role === "tool");
    const name = done ? "done" : "click";
    return Response.json({ model: "deepseek-flash", choices: [{ message: { content: null, tool_calls: [{ id: crypto.randomUUID(), type: "function",
      function: { name, arguments: JSON.stringify(done ? { reason: "Saved" } : { target: { by: "role", role: "button", name: "Save" } }) } }] } }] });
  } });
  const directory = await mkdtemp(join(tmpdir(), "qawarness-repeat-cli-"));
  let summaryPath: string | undefined;
  let manifestPath: string | undefined;
  let runIds: string[] = [];
  try {
    const scenarioPath = join(directory, "save.yaml");
    await writeFile(scenarioPath, `name: save\nstartUrl: http://localhost:${app.port}/\ninstruction: Click Save\nproof:\n  - type: text_visible_after_click\n    target: { by: role, role: button, name: Save }\n    text: Saved\n`);
    const child = Bun.spawn(["bun", "run", "src/repeat.ts", scenarioPath, "--count", "2", "--reset-url", `http://localhost:${app.port}/reset`, "--app-revision", "app-v1", "--fixture", "empty-store"], {
      cwd: process.cwd(), env: { ...process.env, DEEPSEEK_API_KEY: "test-key", DEEPSEEK_BASE_URL: `http://127.0.0.1:${model.port}`, MONGODB_URI: "" }, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (exit !== 0) throw new Error(`Repeat CLI exited ${exit}: ${stderr}\n${stdout}`);
    expect(resets).toBe(2);
    summaryPath = stdout.match(/Summary: (.+)/)?.[1]?.trim();
    manifestPath = stdout.match(/Manifest: (.+)/)?.[1]?.trim();
    expect(summaryPath).toBeTruthy();
    expect(manifestPath).toBeTruthy();
    const summary = JSON.parse(await readFile(summaryPath!, "utf8"));
    runIds = summary.runs.map((run: { runId: string }) => run.runId);
    expect(summary).toMatchObject({ applicationRevision: "app-v1", fixture: "empty-store", passRate: 1, diagnosisCounts: { passed: 2 } });
    expect(runIds).toHaveLength(2);
    const events = (await readFile(manifestPath!, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(events.map(event => event.type)).toEqual([
      "group_started", "attempt_started", "reset_completed", "run_started", "run_finished",
      "attempt_started", "reset_completed", "run_started", "run_finished", "group_finished",
    ]);
    expect(events.filter(event => event.type === "run_finished").map(event => event.runId)).toEqual(runIds);
  } finally {
    app.stop(true); model.stop(true);
    for (const runId of runIds) await rm(join("runs", runId), { recursive: true, force: true });
    if (summaryPath) await rm(summaryPath, { force: true });
    if (manifestPath) await rm(manifestPath, { force: true });
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);

test("repeat CLI rejects an unconfirmed reset and keeps the failed attempt", async () => {
  const app = Bun.serve({ port: 0, fetch(request) {
    if (new URL(request.url).pathname === "/reset") return Response.json({ fixture: "wrong", applicationRevision: "app-v1" });
    return new Response("ready");
  } });
  const directory = await mkdtemp(join(tmpdir(), "qawarness-repeat-reset-"));
  let manifestPath: string | undefined;
  try {
    const scenarioPath = join(directory, "scenario.yaml");
    await writeFile(scenarioPath, `name: reset-check\nstartUrl: http://localhost:${app.port}/\ninstruction: Check the page\nproof:\n  - type: text_visible\n    text: ready\n`);
    const child = Bun.spawn(["bun", "run", "src/repeat.ts", scenarioPath, "--count", "2", "--reset-url", `http://localhost:${app.port}/reset`, "--app-revision", "app-v1", "--fixture", "empty-store"], {
      cwd: process.cwd(), env: { ...process.env, DEEPSEEK_API_KEY: "test-key", MONGODB_URI: "" }, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("Fixture reset did not confirm fixture empty-store and application revision app-v1");
    manifestPath = stderr.match(/Manifest: (.+)/)?.[1]?.trim();
    expect(manifestPath).toBeTruthy();
    const events = (await readFile(manifestPath!, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(events.map(event => event.type)).toEqual(["group_started", "attempt_started", "attempt_failed", "group_failed"]);
    expect(events[2]).toMatchObject({ attempt: 1, phase: "reset" });
  } finally {
    app.stop(true);
    if (manifestPath) await rm(manifestPath, { force: true });
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);

test("repeat CLI records setup failure before the first attempt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qawarness-repeat-setup-"));
  let manifestPath: string | undefined;
  try {
    const scenarioPath = join(directory, "scenario.yaml");
    await writeFile(scenarioPath, "name: setup-check\nstartUrl: http://localhost:3000/\ninstruction: Check the page\nproof:\n  - type: text_visible\n    text: ready\n");
    const child = Bun.spawn(["bun", "run", "src/repeat.ts", scenarioPath, "--count", "1", "--reset-url", "http://localhost:3000/reset", "--app-revision", "app-v1", "--fixture", "empty-store"], {
      cwd: process.cwd(), env: { ...process.env, DEEPSEEK_API_KEY: "", MONGODB_URI: "" }, stdout: "pipe", stderr: "pipe",
    });
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited).toBe(2);
    expect(stderr).toContain("DEEPSEEK_API_KEY is required");
    manifestPath = stderr.match(/Manifest: (.+)/)?.[1]?.trim();
    expect(manifestPath).toBeTruthy();
    const events = (await readFile(manifestPath!, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(events.map(event => event.type)).toEqual(["group_started", "group_failed"]);
  } finally {
    if (manifestPath) await rm(manifestPath, { force: true });
    await rm(directory, { recursive: true, force: true });
  }
});
