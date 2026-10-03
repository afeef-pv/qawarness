import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecordedEvidence } from "./evidence";
import { investigateRecordedFailure, loadRecordedRun } from "./investigator";
import { investigationTimeline } from "./investigation-timeline";

test("timeline locates early errors and preserves ordering, repetition and screenshot timing without granting citation access", async () => {
  const { report, history } = await loadRecordedRun("fixtures/investigation/cases/early-app-error");
  report.initialObservation!.errors = [];
  history[0]!.beforeScreenshot = "before.png";
  history[0]!.screenshot = "after.png";
  history[1]!.observation!.screenshot = "legacy.png";
  history[1]!.observation!.location.url = "http://fixture.invalid/later";
  const access = new RecordedEvidence({ directory: ".", instruction: "Save", history, initialObservation: report.initialObservation, finalObservation: report.finalObservation });
  const timeline = investigationTimeline(report, access);
  expect(timeline.events[0]).toMatchObject({ sequence: 1, highlights: ["new_application_errors"], newErrors: ["pageerror: Save handler crashed"], observations: { before: 0, recorded: 1, subsequent: 2 } });
  expect(timeline.events[0]!.screenshots).toEqual([{ id: "step-1-before", timing: "Before this action" }, { id: "step-1-after", timing: "After this action" }]);
  expect(timeline.events[1]!.screenshots[0]?.timing).toContain("may precede");
  expect(timeline.events[1]!.changedUrl?.to).toBe("http://fixture.invalid/later");
  expect(timeline.events[2]!.highlights).toContain("repeated_action");
  expect(timeline.events[2]!.newErrors).toEqual([]);
  expect(timeline.failedProofIndexes).toEqual([0]);
  expect(access.readSteps.size).toBe(0);
  expect(access.observationRanges.size).toBe(0);
  expect(access.viewedIds.size).toBe(0);
});

test("investigator discovers an early transition from initial index and records retrieved support", async () => {
  const directory = "fixtures/investigation/cases/early-app-error";
  const { report, history } = await loadRecordedRun(directory);
  report.initialObservation!.errors = [];
  const destination = await mkdtemp(join(tmpdir(), "timeline-review-"));
  let turn = 0;
  try {
    const investigation = await investigateRecordedFailure(report, history, directory, { name: "fake", async generate(request) {
      const user = request.messages[1]!;
      if (user.role !== "user" || typeof user.content !== "string") throw new Error("Expected text fixture summary");
      const summary = JSON.parse(user.content);
      expect(summary.timeline.events[0].newErrors).toContain("pageerror: Save handler crashed");
      const call = turn++ === 0 ? { name: "read_steps", arguments: { from: summary.timeline.events[0].sequence, count: 2 } } : {
        name: "finish_investigation", arguments: { classification: "product_failure", reason: "Save raised a recorded application error", proofIndexes: [0], errorIndexes: [], finding: {
          expected: "Save confirmation", observed: "Application error during Save", cause: "Save handler raised an application error", alternativeExplanation: "Driver chose another control", alternativeAssessment: "Step 1 records Save click", unknowns: ["Internal backend cause unknown"], neededEvidence: [], citations: [{ claim: "observed", kind: "step", sequence: 1 }, { claim: "cause", kind: "step", sequence: 1 }, { claim: "alternative", kind: "step", sequence: 1 }],
        } },
      };
      return { provider: "fake", model: "fake", text: "", toolCalls: [{ id: String(turn), ...call }] };
    } }, { transcript: join(destination, "review.jsonl") });
    expect(investigation.status).toBe("completed");
    expect(turn).toBe(2);
    const transcript = (await readFile(join(destination, "review.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(transcript[0].summary).toContain('"timeline"');
    expect(transcript[1]).toMatchObject({ tool: "read_steps", arguments: { from: 1, count: 2 } });
    expect(investigation.diagnosis?.evidence.stepSequences).toEqual([1]);
  } finally { await rm(destination, { recursive: true, force: true }); }
});

test("oversized imported histories disclose omissions and retain early failed actions", async () => {
  const { report, history } = await loadRecordedRun("fixtures/investigation/cases/early-app-error");
  const expanded = Array.from({ length: 300 }, (_, index) => ({ ...history[0]!, sequence: index + 1, status: "failed" as const }));
  const access = new RecordedEvidence({ directory: ".", instruction: "Save", history: expanded });
  const timeline = investigationTimeline(report, access);
  expect(timeline.totalEvents).toBe(300);
  expect(timeline.events.length).toBeLessThanOrEqual(200);
  expect(timeline.omittedEvents).toBe(300 - timeline.events.length);
  expect(timeline.events[0]?.sequence).toBe(1);
  expect(timeline.events.at(-1)?.sequence).toBe(300);
  expect(timeline.events[0]?.highlights).toContain("failed_action");
  const page = await access.read("read_steps", { from: 200, count: 1 });
  expect(JSON.parse(page.text).steps[0].sequence).toBe(200);
});
