import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("repeat CLI resets each run and writes a comparable summary", async () => {
  let saved = false;
  let resets = 0;
  const app = Bun.serve({ port: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/reset" && request.method === "POST") { saved = false; resets++; return new Response("reset"); }
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
    expect(summaryPath).toBeTruthy();
    const summary = JSON.parse(await readFile(summaryPath!, "utf8"));
    runIds = summary.runs.map((run: { runId: string }) => run.runId);
    expect(summary).toMatchObject({ applicationRevision: "app-v1", fixture: "empty-store", passRate: 1, diagnosisCounts: { passed: 2 } });
    expect(runIds).toHaveLength(2);
  } finally {
    app.stop(true); model.stop(true);
    for (const runId of runIds) await rm(join("runs", runId), { recursive: true, force: true });
    if (summaryPath) await rm(summaryPath, { force: true });
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);
