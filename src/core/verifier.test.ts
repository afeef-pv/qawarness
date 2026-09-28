import { expect, test } from "bun:test";
import { verifyProof } from "./verifier";
import type { QAEnvironment, QAObservation } from "./environment";
import type { ExecutionRecord } from "./recorder";

const observation = (text: string, errors: string[] = []): QAObservation => ({ platform: "web", location: { url: "http://localhost/" }, text, elements: [], errors });
const environment: QAEnvironment = {
  async start() {}, async navigate() {}, async close() {},
  async act() { return { success: true }; },
  async observe() { return observation(""); },
  async inspect() { return { count: 0, elements: [] }; },
  async screenshot() {},
};

test("temporal proof accepts a later observation after the click and rejects preexisting text", async () => {
  const target = { by: "role" as const, role: "button", name: "Save" };
  const proof = [{ type: "text_visible_after_click" as const, target, text: "Saved" }];
  const history: ExecutionRecord[] = [
    { sequence: 1, action: { type: "click", target }, startedAt: "", durationMs: 1, status: "succeeded", observation: observation("Saving") },
    { sequence: 2, action: { type: "inspect", target }, startedAt: "", durationMs: 1, status: "succeeded", observation: observation("Saved") },
  ];
  expect((await verifyProof(proof, environment, observation("Saved"), history, observation("Unsaved"))).results[0])
    .toMatchObject({ passed: true, observed: { matchedStep: 1, appearedAtStep: 2, finalVisible: true } });
  expect((await verifyProof(proof, environment, observation("Saved"), history, observation("Saved"))).results[0]?.passed).toBe(false);
});

test("application error proof reads the whole run, including errors cleared by navigation", async () => {
  const history: ExecutionRecord[] = [{ sequence: 1, action: { type: "navigate", url: "http://localhost/next" }, startedAt: "", durationMs: 1, status: "succeeded", observation: observation("Next", ["pageerror: crashed"]) }];
  const result = await verifyProof([{ type: "no_application_errors" }], environment, observation("Clean final page"), history, observation("Initial"));
  expect(result.results[0]).toMatchObject({ passed: false, observed: ["pageerror: crashed"] });
});
