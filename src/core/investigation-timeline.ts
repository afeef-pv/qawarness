import type { RecordedEvidence } from "./evidence";
import type { RunReport } from "./runner";

// An index locates evidence. It does not grant access to full records or images.
export function investigationTimeline(report: RunReport, access: RecordedEvidence) {
  const history = access.input.history;
  const clip = (text: string) => text.length > 240 ? text.slice(0, 240) + "… [truncated]" : text;
  let previousObservation = report.initialObservation;
  let previousAction: string | undefined;
  const seenErrors = new Set(report.initialObservation?.errors ?? []);
  const seenDiagnostics = new Set<string>();
  const events = history.map((record, index) => {
    const actionKey = JSON.stringify(record.action);
    const repeated = actionKey === previousAction;
    previousAction = actionKey;
    const newErrors = (record.observation?.errors ?? []).filter(error => !seenErrors.has(error));
    newErrors.forEach(error => seenErrors.add(error));
    const beforeUrl = previousObservation?.location.url;
    const afterUrl = record.observation?.location.url;
    if (record.observation) previousObservation = record.observation;
    const highlights = [
      ...(record.status === "failed" ? ["failed_action"] : []),
      ...(repeated ? ["repeated_action"] : []),
      ...(newErrors.length ? ["new_application_errors"] : []),
      ...(record.evidenceError ? ["recording_error"] : []),
      ...(record.status === "done" ? ["driver_done"] : []),
    ];
    return {
      sequence: record.sequence, timestamp: record.startedAt, durationMs: record.durationMs,
      action: { type: record.action.type, ...("target" in record.action ? { target: clip(JSON.stringify(record.action.target)) } : {}) },
      outcome: record.status, highlights,
      ...(record.error ? { actionError: clip(record.error) } : {}),
      ...(record.evidenceError ? { recordingError: clip(record.evidenceError) } : {}),
      ...(afterUrl && afterUrl !== beforeUrl ? { changedUrl: { from: beforeUrl ? clip(beforeUrl) : null, to: clip(afterUrl) } } : {}),
      diagnostics: (record.observation?.diagnostics ?? []).filter(event => {
        if (seenDiagnostics.has(event.id)) return false;
        seenDiagnostics.add(event.id); return true;
      }).slice(0, 20).map(event => ({ ...event, correlation: Date.parse(event.occurredAt) >= Date.parse(record.startedAt) && Date.parse(event.occurredAt) <= Date.parse(record.startedAt) + record.durationMs
        ? "occurred_during_action_interval" : "occurred_outside_action_interval", causalAssignment: "unestablished" })),
      newErrors: newErrors.slice(0, 5).map(clip), omittedNewErrors: Math.max(0, newErrors.length - 5),
      observations: { before: index === 0 ? (report.initialObservation ? 0 : null) : history[index - 1]?.observation ? history[index - 1]!.sequence : null,
        recorded: record.observation ? record.sequence : null,
        subsequent: history[index + 1]?.observation ? history[index + 1]!.sequence : report.finalObservation && index === history.length - 1 ? -1 : null },
      screenshots: access.screenshots.filter(image => image.sequence === record.sequence).map(({ id, timing }) => ({ id, timing })),
    };
  });
  // Normal runs have at most 200 steps. For larger imported recordings, retain
  // early highlighted transitions first and disclose omissions for read_steps.
  const selected = events.length <= 200 ? events : events.filter(event => event.highlights.length).slice(0, 150);
  if (events.length > 200) for (const event of [...events.slice(0, 25), ...events.slice(-25)]) {
    if (selected.length < 200 && !selected.includes(event)) selected.push(event);
  }
  selected.sort((a, b) => a.sequence - b.sequence);
  return {
    schemaVersion: 1,
    diagnosticIndex: access.diagnostics.slice(0, 200).map(event => ({ id: event.id, kind: event.kind, occurredAt: event.occurredAt, request: event.request })),
    omittedDiagnostics: Math.max(0, access.diagnostics.length - 200),
    purpose: "Investigation starting points, not established causes. Retrieve full content before citing steps or observations; screenshot IDs are not viewed images.",
    timing: "A subsequent observation or next-action before image establishes a later state, not the exact instant after an action. Legacy recorded screenshots may precede their action.",
    initial: { observation: report.initialObservation ? 0 : null, errors: (report.initialObservation?.errors ?? []).slice(0, 5).map(clip), omittedErrors: Math.max(0, (report.initialObservation?.errors.length ?? 0) - 5), url: report.initialObservation?.location.url ? clip(report.initialObservation.location.url) : null },
    final: { observation: report.finalObservation ? -1 : null, screenshot: access.viewedIds.has("final") ? "final" : null },
    failedProofIndexes: report.proofResults.flatMap((proof, index) => proof.passed ? [] : [index]),
    totalEvents: events.length, omittedEvents: events.length - selected.length, events: selected,
  };
}
