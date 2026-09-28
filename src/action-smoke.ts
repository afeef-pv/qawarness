import { strict as assert } from "node:assert";
import { readFile, rm } from "node:fs/promises";

import { QAExecutor } from "./core/executor";
import { JsonlRecorder, type ExecutionRecord } from "./core/recorder";
import { PlaywrightEnvironment } from "./environments/playwright";

const runDirectory = "runs/action-smoke";
const logPath = `${runDirectory}/actions.jsonl`;
const screenshotPath = `${runDirectory}/page.png`;

const server = Bun.serve({
  port: 0,
  fetch() {
    return new Response(`<!doctype html>
      <title>Action smoke</title>
      <label for="customer">Customer</label>
      <input id="customer" data-testid="customer-input">
      <select data-testid="tier"><option value="basic">Basic</option><option value="pro">Pro</option></select>
      <button type="button" onclick="document.querySelector('#output').textContent = 'Created ' + document.querySelector('#customer').value; console.error('sample diagnostic')">Create customer</button>
      <p id="output"></p>
      <script>document.querySelector('#customer').addEventListener('keydown', event => {
        if (event.key === 'Enter') document.querySelector('#pressed').textContent = 'Enter pressed';
      });</script>
      <p id="pressed"></p>`, { headers: { "content-type": "text/html" } });
  },
});

const environment = new PlaywrightEnvironment();

try {
  await rm(logPath, { force: true });
  await environment.start();
  const executor = new QAExecutor(environment, new JsonlRecorder(logPath));

  await executor.execute({ type: "navigate", url: `http://localhost:${server.port}/` });
  await executor.execute({ type: "fill", target: { by: "label", label: "Customer" }, value: "Ada" });
  await executor.execute({ type: "select", target: { by: "testId", id: "tier" }, value: "pro" });
  await executor.execute({ type: "press", target: { by: "css", selector: "#customer" }, key: "Enter" });
  const clicked = await executor.execute({ type: "click", target: { by: "role", role: "button", name: "Create customer" } });
  assert.equal(clicked.status, "succeeded");
  assert.match(clicked.observation?.text ?? "", /Created Ada/);
  assert.match(clicked.observation?.text ?? "", /Enter pressed/);
  assert.ok(clicked.observation?.elements.some((element) => element.role === "button" && element.text === "Create customer"));
  assert.ok(clicked.observation?.errors.some((error) => error.includes("sample diagnostic")));

  await executor.execute({ type: "scroll", deltaY: 100 });
  const screenshot = await executor.execute({ type: "screenshot", path: screenshotPath });
  assert.equal(screenshot.observation?.screenshot, screenshotPath);

  const failed = await executor.execute({ type: "click", target: { by: "css", selector: "button[" } });
  assert.equal(failed.status, "failed");
  assert.ok(failed.error);

  const done = await executor.execute({ type: "done", reason: "Created customer is visible" });
  assert.equal(done.status, "done");
  assert.match(done.observation?.text ?? "", /Created Ada/);
  await assert.rejects(executor.execute({ type: "scroll", deltaY: 1 }), /already done/);

  const records = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as ExecutionRecord);
  assert.equal(records.length, 9);
  assert.deepEqual(records.map((record) => record.sequence), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(records[0]?.status, "succeeded");
  assert.equal(records[7]?.status, "failed");
  assert.equal(records[8]?.status, "done");
  assert.equal(records[8]?.action.type, "done");
  console.log("Action smoke passed:", logPath, screenshotPath);
} finally {
  await environment.close();
  server.stop(true);
}
