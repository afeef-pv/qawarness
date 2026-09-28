import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { connectMongoRunStore } from "../persistence/mongo/client";

const artifactFiles: Record<string, string> = {
  screenshot: "final.png", report: "report.json", actions: "actions.jsonl", initialObservation: "initial-observation.json", observation: "final-observation.json", trace: "trace.zip",
};
const runIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const text = (value: unknown, limit = 12_000) => typeof value === "string" ? value.slice(0, limit) : value;
const observation = (value: any) => value ? {
  url: value.location?.url, title: value.location?.title, text: text(value.text),
  errors: Array.isArray(value.errors) ? value.errors.slice(0, 20).map((error: unknown) => text(error, 2_000)) : [],
  elements: Array.isArray(value.elements) ? value.elements.slice(0, 100) : [],
} : undefined;

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function runSummary(run: any, current = observation(run.finalObservation)) {
  return {
    runId: run.id ?? run._id, scenario: run.scenario, status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt,
    stepCount: run.stepCount, maxSteps: run.limits?.maxSteps, current: current ? { url: current.url, title: current.title } : undefined, agent: run.agent,
  };
}

export async function createDashboardServer(options: { port?: number; hostname?: string; staticDirectory?: string } = {}) {
  const uri = Bun.env.MONGODB_URI;
  if (!uri) throw new Error("Dashboard requires MONGODB_URI; it only reads persisted MongoDB run history.");
  const mongo = await connectMongoRunStore(uri, Bun.env.MONGODB_DB || "qawarness");
  const runsDirectory = resolve(process.cwd(), "runs");
  const server = Bun.serve({
    hostname: options.hostname ?? "127.0.0.1", port: options.port ?? 7332,
    async fetch(request) {
      const url = new URL(request.url);
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      try {
        if (url.pathname === "/api/runs") {
          const runs = await mongo.store.listRuns(100);
          return json(await Promise.all(runs.map(async run => runSummary(run, observation(run.finalObservation) ?? observation((await mongo.store.getLatestRunStep(run.id))?.observation)))));
        }
        if (parts[0] === "api" && parts[1] === "runs" && parts.length === 3) {
          const run = await mongo.store.getRun(parts[2]!);
          if (!run) return json({ error: "Run not found" }, 404);
          const definition = await mongo.store.getScenarioDefinition(run.scenario.definitionId);
          const latestStep = await mongo.store.getLatestRunStep(run.id);
          const currentObservation = observation(run.finalObservation) ?? observation(latestStep?.observation);
          return json({ ...runSummary(run, currentObservation), completion: run.completion, limits: run.limits, environment: run.environment,
            execution: run.execution, verification: run.verification, diagnosis: run.diagnosis, context: run.context,
            scenarioDefinition: definition ? { id: definition.id, name: definition.name, version: definition.version, startUrl: definition.startUrl, instruction: definition.instruction, proof: definition.proof, maxSteps: definition.maxSteps, maxDuration: definition.maxDuration } : { ...run.scenarioSnapshot, name: run.scenario.name, version: run.scenario.version },
            proofResults: run.proofResults ?? [], errors: run.errors ?? [], initialObservation: observation(run.initialObservation), finalObservation: observation(run.finalObservation), currentObservation,
            artifacts: Object.entries(artifactFiles).filter(([, filename]) => existsSync(resolve(runsDirectory, run.id, filename))).map(([key, filename]) => ({ key, filename, url: `/api/runs/${encodeURIComponent(run.id)}/artifacts/${key}` })),
          });
        }
        if (parts[0] === "api" && parts[1] === "runs" && parts[3] === "steps" && parts.length === 4) {
          const run = await mongo.store.getRun(parts[2]!);
          if (!run) return json({ error: "Run not found" }, 404);
          const steps = await mongo.store.getRunSteps(parts[2]!);
          return json(steps.map((step: any) => ({ sequence: step.sequence, startedAt: step.startedAt, finishedAt: step.finishedAt, durationMs: step.durationMs, status: step.status, action: step.action, error: text(step.error, 2_000), evidenceError: text(step.evidenceError, 2_000), observation: observation(step.observation), inspection: step.inspection,
            screenshotUrl: step.screenshot ? step.status === "done" ? `/api/runs/${encodeURIComponent(run.id)}/artifacts/screenshot` : `/api/runs/${encodeURIComponent(run.id)}/artifacts/steps/${step.sequence}` : undefined })));
        }
        if (parts[0] === "api" && parts[1] === "scenarios" && parts.length === 3) {
          const definition = await mongo.store.getScenarioDefinition(parts[2]!);
          return definition ? json(definition) : json({ error: "Scenario definition not found" }, 404);
        }
        if (parts[0] === "api" && parts[1] === "runs" && parts[3] === "artifacts" && parts.length === 5) {
          const runId = parts[2]!;
          const filename = artifactFiles[parts[4]!];
          if (!runIdPattern.test(runId) || !filename) return json({ error: "Artifact not found" }, 404);
          if (!await mongo.store.getRun(runId)) return json({ error: "Run not found" }, 404);
          const path = resolve(runsDirectory, runId, filename);
          const directory = resolve(runsDirectory, runId);
          if (!path.startsWith(`${directory}/`) || !existsSync(path)) return json({ error: "Artifact not found" }, 404);
          const actual = await realpath(path);
          if (basename(actual) !== filename || !actual.startsWith(`${await realpath(directory)}/`)) return json({ error: "Artifact not found" }, 404);
          return new Response(Bun.file(actual), { headers: { "content-disposition": `inline; filename="${filename}"` } });
        }
        if (parts[0] === "api" && parts[1] === "runs" && parts[3] === "artifacts" && parts[4] === "steps" && parts.length === 6) {
          const runId = parts[2]!;
          const sequence = Number(parts[5]);
          if (!runIdPattern.test(runId) || !Number.isSafeInteger(sequence) || sequence < 1) return json({ error: "Artifact not found" }, 404);
          if (!await mongo.store.getRun(runId)) return json({ error: "Run not found" }, 404);
          const step = await mongo.store.getRunStep(runId, sequence);
          if (!step || step.status !== "failed" || typeof step.screenshot !== "string") return json({ error: "Artifact not found" }, 404);
          const expected = resolve(runsDirectory, runId, "steps", `${String(sequence).padStart(6, "0")}-failed.png`);
          if (resolve(step.screenshot) !== expected || !existsSync(expected)) return json({ error: "Artifact not found" }, 404);
          const actual = await realpath(expected);
          if (!actual.startsWith(`${await realpath(resolve(runsDirectory, runId))}/`)) return json({ error: "Artifact not found" }, 404);
          return new Response(Bun.file(actual), { headers: { "content-type": "image/png", "cache-control": "no-store" } });
        }
        if (options.staticDirectory && request.method === "GET") {
          const relativePath = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
          const path = resolve(options.staticDirectory, relativePath);
          if (path.startsWith(`${resolve(options.staticDirectory)}/`) && existsSync(path)) return new Response(Bun.file(path));
          return new Response(Bun.file(resolve(options.staticDirectory, "index.html")));
        }
        return json({ error: "Not found" }, 404);
      } catch (error) {
        console.error(error);
        return json({ error: "Dashboard data is temporarily unavailable" }, 503);
      }
    },
  });
  return { server, close: async () => { server.stop(); await mongo.client.close(); } };
}

if (import.meta.main) {
  const staticDirectory = Bun.env.DASHBOARD_STATIC === "1" ? resolve(process.cwd(), "apps/dashboard/dist") : undefined;
  const dashboard = await createDashboardServer({ port: staticDirectory ? 7331 : 7332, staticDirectory });
  if (staticDirectory) {
    console.log("Dashboard: http://127.0.0.1:7331");
  } else {
  const vite = Bun.spawn(["bunx", "vite", "--config", "apps/dashboard/vite.config.ts", "--host", "127.0.0.1", "--port", "7331"], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  console.log("Dashboard API: http://127.0.0.1:7332\nDashboard UI:  http://127.0.0.1:7331");
  const close = async () => { vite.kill(); await dashboard.close(); process.exit(); };
  process.on("SIGINT", close); process.on("SIGTERM", close);
  await vite.exited;
  await dashboard.close();
  }
}
