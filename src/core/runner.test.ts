import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgentAction } from "./agent";
import { parseScenario } from "./scenario";
import { runScenario } from "./runner";
import { PlaywrightEnvironment } from "../environments/playwright";
import type { LLMProvider } from "./llm/provider";

test("scenario and model action boundaries reject malformed input", () => {
  expect(() => parseScenario({ name: "x", startUrl: "http://localhost", instruction: "do it", proof: [{ type: "unknown" }] })).toThrow();
  expect(() => parseAgentAction("click", { target: { by: "coordinates", x: "1", y: 2 } })).toThrow();
  expect(() => parseAgentAction("evaluate", { script: "alert(1)" })).toThrow();
});

test("runner executes one action, done and independent proof", async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response('<title>Test</title><button onclick="document.querySelector(\'p\').textContent=\'Created Ada\'">Create</button><p></p>', { headers: { "content-type": "text/html" } }) });
  const directory = await mkdtemp(join(tmpdir(), "qawarness-"));
  let turn = 0;
  const provider: LLMProvider = { name: "fake", async generate(request) {
    if (turn === 0) expect(JSON.stringify(request.messages)).not.toContain("Created Ada");
    const calls = [
      { id: "1", name: "click", arguments: { target: { by: "role", role: "button", name: "Create" } } },
      { id: "2", name: "done", arguments: { reason: "Created" } },
    ];
    return { provider: "fake", model: "fake", text: "", toolCalls: [calls[turn++]!] };
  } };
  try {
    const report = await runScenario(parseScenario({ name: "create", startUrl: `http://localhost:${server.port}/`, instruction: "Click Create", proof: [
      { type: "text_visible", text: "Created Ada" },
      { type: "text_not_visible", text: "Missing customer" },
      { type: "url_contains", value: `localhost:${server.port}` },
      { type: "element_visible", target: { by: "role", role: "button", name: "Create" } },
      { type: "element_text", target: { by: "role", role: "button", name: "Create" }, equals: "Create" },
    ] }), provider, new PlaywrightEnvironment({ tracePath: join(directory, "trace.zip") }), directory);
    expect(report.result).toBe("passed");
    expect(report.steps).toBe(2);
    expect(report.proofResults[0]?.passed).toBe(true);
    expect(report.proofResults).toHaveLength(5);
    expect((await readFile(join(directory, "actions.jsonl"), "utf8")).trim().split("\n")).toHaveLength(2);
    expect((await Bun.file(join(directory, "final.png")).exists())).toBe(true);
    expect((await Bun.file(join(directory, "trace.zip")).exists())).toBe(true);
  } finally { server.stop(true); await rm(directory, { recursive: true, force: true }); }
});
