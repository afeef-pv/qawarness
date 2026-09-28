import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

test("open run detail updates when the run finishes", async () => {
  const build = Bun.spawnSync(["bun", "run", "dashboard:build"], { stdout: "pipe", stderr: "pipe" });
  expect(build.exitCode).toBe(0);
  const dist = resolve("apps/dashboard/dist");
  let detailRequests = 0;
  const started = Date.now();
  const server = Bun.serve({ port: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/runs/test") {
      detailRequests++;
      const finished = Date.now() - started > 1_000;
      return Response.json({ runId: "test", scenario: { name: "live", version: 1 }, scenarioDefinition: { name: "live", version: 1, startUrl: "http://localhost/", instruction: "Check state", maxSteps: 3 },
        status: finished ? "passed" : "running", startedAt: "2026-01-01T00:00:00Z", finishedAt: finished ? "2026-01-01T00:00:02Z" : undefined,
        stepCount: finished ? 2 : 1, proofResults: finished ? [{ proof: { type: "text_visible", text: "Ready" }, passed: true, observed: true }] : [], errors: [],
        artifacts: finished ? [{ key: "report", filename: "report.json", url: "/fake/report" }] : [] });
    }
    if (url.pathname === "/api/runs/test/steps") return Response.json([]);
    const file = resolve(dist, url.pathname.slice(1));
    return new Response(Bun.file(file.startsWith(`${dist}/`) && existsSync(file) ? file : resolve(dist, "index.html")));
  } });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`http://localhost:${server.port}/runs/test`, { waitUntil: "domcontentloaded", timeout: 5_000 });
    await page.getByText("running", { exact: true }).waitFor();
    await page.getByText("passed", { exact: true }).waitFor({ timeout: 6_000 });
    expect(detailRequests).toBeGreaterThan(1);
    await page.getByText("Expected: Ready", { exact: true }).waitFor();
    await page.getByText("report.json", { exact: true }).waitFor();
  } finally { await browser.close(); server.stop(true); }
}, 15_000);
