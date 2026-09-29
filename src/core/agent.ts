import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { QAExecutionAction } from "./actions";
import type { QAEnvironment, QAObservation } from "./environment";
import { QAExecutor } from "./executor";
import type { LLMMessage, LLMProvider, LLMTool } from "./llm/provider";
import type { ExecutionRecord } from "./recorder";
import { object, parseTarget, type QAScenario } from "./scenario";

const target = { type: "object", description: "Prefer role and accessible name, then label, text, testId, CSS. Coordinates only for click.", properties: { by: { type: "string", enum: ["role", "label", "text", "testId", "css", "coordinates"] }, role: { type: "string" }, name: { type: "string" }, label: { type: "string" }, text: { type: "string" }, id: { type: "string" }, selector: { type: "string" }, x: { type: "number" }, y: { type: "number" } }, required: ["by"] };
const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[]): LLMTool => ({ name, description, inputSchema: { type: "object", properties, required } });
export const QA_TOOLS: LLMTool[] = [
  tool("navigate", "Go to an HTTP(S) URL", { url: { type: "string" } }, ["url"]),
  tool("click", "Click a semantic target visible in the current screenshot", { target }, ["target"]),
  tool("fill", "Fill an input", { target, value: { type: "string" } }, ["target", "value"]),
  tool("select", "Select an option by value", { target, value: { type: "string" } }, ["target", "value"]),
  tool("press", "Press a key on a target", { target, key: { type: "string" } }, ["target", "key"]),
  tool("scroll", "Scroll page in pixels", { deltaY: { type: "number" }, deltaX: { type: "number" } }, ["deltaY"]),
  tool("wait", "Wait briefly for a loading screen or transition, then view a fresh screenshot", { milliseconds: { type: "integer", minimum: 100, maximum: 3000 } }, ["milliseconds"]),
  tool("inspect", "Inspect matching elements for current state", { target }, ["target"]),
  tool("done", "Task appears complete and evidence supports the required proof; start independent verification", { reason: { type: "string" } }, ["reason"]),
];
export function parseAgentAction(name: string, v: unknown): QAExecutionAction {
  if (!object(v)) throw new Error("tool arguments must be an object");
  switch (name) {
    case "navigate": { if (typeof v.url !== "string" || !/^https?:\/\//.test(v.url)) break; return { type: "navigate", url: v.url }; }
    case "click": { if (object(v.target) && v.target.by === "coordinates") { if (typeof v.target.x === "number" && Number.isFinite(v.target.x) && typeof v.target.y === "number" && Number.isFinite(v.target.y)) return { type: "click", target: { by: "coordinates", x: v.target.x, y: v.target.y } }; break; } return { type: "click", target: parseTarget(v.target) }; }
    case "fill": case "select": if (typeof v.value === "string") return { type: name, target: parseTarget(v.target), value: v.value }; break;
    case "press": if (typeof v.key === "string" && v.key.trim()) return { type: "press", target: parseTarget(v.target), key: v.key }; break;
    case "scroll": if (typeof v.deltaY === "number" && Number.isFinite(v.deltaY) && (v.deltaX === undefined || typeof v.deltaX === "number" && Number.isFinite(v.deltaX))) return { type: "scroll", deltaY: v.deltaY, ...(v.deltaX === undefined ? {} : { deltaX: v.deltaX }) }; break;
    case "wait": if (Number.isInteger(v.milliseconds) && (v.milliseconds as number) >= 100 && (v.milliseconds as number) <= 3000) return { type: "wait", milliseconds: v.milliseconds as number }; break;
    case "inspect": return { type: "inspect", target: parseTarget(v.target) };
    case "done": if (typeof v.reason === "string" && v.reason.trim()) return { type: "done", reason: v.reason }; break;
  }
  throw new Error(`invalid arguments for ${name}`);
}
export function summarizeObservation(o: QAObservation): string {
  const elements = o.elements.filter(e => e.visible).slice(0, 80).map(e => `[${e.role ?? "element"}] ${JSON.stringify((e.label ?? e.text ?? "").replace(/\s+/g, " ").trim().slice(0, 120))}${e.id ? ` id=${e.id}` : ""}${e.enabled ? "" : " disabled"}`).join("\n");
  return `URL: ${(o.location.url ?? "").slice(0, 1000)}\nTitle: ${(o.location.title ?? "").slice(0, 300)}\nVisible text:\n${o.text.slice(0, 8000)}\nInteractive elements:\n${elements}\nErrors:\n${o.errors.slice(-10).map(error => error.slice(0, 500)).join("\n")}`;
}
export interface AgentResult { status: "done" | "max_steps" | "max_duration" | "agent_protocol_error" | "stalled"; completionReason?: string; stopReason?: string; steps: number; finalObservation: QAObservation }
export async function runAgent(scenario: QAScenario, environment: QAEnvironment, provider: LLMProvider, executor: QAExecutor,
  limits: { maxSteps: number; signal: AbortSignal; screenshotDirectory: string }): Promise<AgentResult> {
  let observation = await environment.observe();
  const viewport = (await environment.runtimeInfo?.())?.viewport;
  const visibleState = (o: QAObservation) => JSON.stringify({ location: o.location, text: o.text, elements: o.elements.filter(element => element.visible) });
  const messages: LLMMessage[] = [
    { role: "system", content: "You execute a QA task in an app. Use the instruction and required proof to understand the goal. Assess progress from the latest screenshot, normalized observation, and action results. The screenshot shows which screen is on top; DOM text and elements may include controls covered by an overlay. Act only on controls visible in the screenshot. Use only one provided tool per turn. Prefer role/name, then label, text, testId, CSS, coordinates. For role/name, use the complete observed name, including symbols. Inspect before guessing. If the screen shows a transition or loading state, use wait for a fresh view. Recover from ordinary action failures. Call done when you believe the task is complete and the observed evidence supports all required proof. Independent verification decides whether the test passed; done only requests verification, and prose is not completion. Avoid unnecessary actions." },
    { role: "user", content: `${scenario.description ? `Description:\n${scenario.description}\n\n` : ""}Instruction:\n${scenario.instruction}\n\nRequired proof:\n${JSON.stringify(scenario.proof, null, 2)}${viewport ? `\n\nScreenshot dimensions: ${viewport.width} × ${viewport.height} pixels.` : ""}` },
  ];
  let steps = 0;
  let protocolErrors = 0;
  let previousAction = "";
  let previousState = visibleState(observation);
  let repeatedActions = 0;
  let lastClickSucceeded = false;
  let pendingClick: { key: string; waitedMs: number; target: Extract<QAExecutionAction, { type: "click" }>["target"]; url?: string } | undefined;
  while (steps < limits.maxSteps) {
    if (limits.signal.aborted) return { status: "max_duration", steps, finalObservation: observation };
    if (lastClickSucceeded) await new Promise(resolve => setTimeout(resolve, 300));
    observation = await environment.observe();
    const screenshotPath = join(limits.screenshotDirectory, `${String(steps).padStart(6, "0")}.png`);
    await environment.screenshot(screenshotPath);
    if ((await stat(screenshotPath)).size > 20 * 1024 * 1024) throw new Error("Agent screenshot exceeds the 20 MiB image limit");
    messages.push({ role: "user", content: [
      { type: "text", text: `Current state:\n${summarizeObservation(observation)}\n\nScreenshot of the current screen:` },
      { type: "image", dataUrl: `data:image/png;base64,${(await readFile(screenshotPath)).toString("base64")}`, detail: "original" },
    ] });
    let response;
    try { response = await provider.generate({ messages, tools: QA_TOOLS, temperature: 0, signal: limits.signal }); }
    catch (error) {
      if (limits.signal.aborted) return { status: "max_duration", steps, finalObservation: observation };
      throw error;
    }
    messages.pop(); // Keep only the current image in each provider request.
    if (limits.signal.aborted) return { status: "max_duration", steps, finalObservation: observation };
    const calls = response.toolCalls ?? [];
    if (calls.length !== 1) {
      if (++protocolErrors >= 3) return { status: "agent_protocol_error", stopReason: "Agent repeatedly failed to call exactly one QA tool.", steps, finalObservation: observation };
      messages.push({ role: "user", content: "Protocol correction: call exactly one QA tool. No prose or multiple tools." });
      continue;
    }
    protocolErrors = 0;
    const call = calls[0]!;
    messages.push({ role: "assistant", content: response.text, toolCalls: calls });
    let result: string;
    let action: ReturnType<typeof parseAgentAction>;
    try {
      action = parseAgentAction(call.name, call.arguments);
    } catch (error) {
      result = `Tool error: ${error instanceof Error ? error.message : String(error)}`;
      messages.push({ role: "tool", toolCallId: call.id, content: result });
      if (++protocolErrors >= 3) return { status: "agent_protocol_error", stopReason: "Agent repeatedly sent invalid QA tool arguments.", steps, finalObservation: observation };
      continue;
    }
    const actionKey = JSON.stringify(action);
    if (action.type === "click" && pendingClick?.key === actionKey) {
      if (pendingClick.waitedMs >= 12_000) return { status: "stalled", stopReason: "The same click was withheld because its previous attempt produced no confirmed screen change after 12 seconds.", steps, finalObservation: observation };
      const waitMs = 1_500;
      steps++;
      const record = await executor.execute({ type: "wait", milliseconds: waitMs, reason: "pending_click" });
      pendingClick.waitedMs += waitMs;
      lastClickSucceeded = false;
      observation = record.observation ?? await environment.observe();
      if (observation.location.url !== pendingClick.url ||
        pendingClick.target.by !== "coordinates" && (await environment.inspect(pendingClick.target)).count === 0) pendingClick = undefined;
      if (limits.signal.aborted) return { status: "max_duration", steps, finalObservation: observation };
      messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify({ status: "deferred", reason: "Previous click has not shown a result yet; waited for a fresh screen instead of clicking again.", observation: summarizeObservation(observation) }) });
      continue;
    }
    if (action.type !== "wait") pendingClick = undefined;
    const stateBeforeAction = visibleState(observation);
    steps++;
    const record: ExecutionRecord = await executor.execute(action);
    lastClickSucceeded = action.type === "click" && record.status === "succeeded";
    if (limits.signal.aborted) return { status: "max_duration", steps, finalObservation: record.observation ?? observation };
    if (action.type === "done") return { status: "done", completionReason: action.reason, steps, finalObservation: record.observation ?? observation };
    observation = record.observation ?? await environment.observe();
    const state = visibleState(observation);
    if (lastClickSucceeded && state === stateBeforeAction && action.type === "click") pendingClick = { key: actionKey, waitedMs: 0, target: action.target, url: observation.location.url };
    if (state !== previousState) repeatedActions = 0;
    else repeatedActions = actionKey === previousAction ? repeatedActions + 1 : 1;
    previousAction = actionKey;
    previousState = state;
    if (repeatedActions >= 5) return { status: "stalled", stopReason: "The same action produced no visible state change five times in a row.", steps, finalObservation: observation };
    result = JSON.stringify({ status: record.status, error: record.error, inspection: record.inspection, observation: summarizeObservation(observation) });
    messages.push({ role: "tool", toolCallId: call.id, content: result });
  }
  return { status: "max_steps", steps, finalObservation: await environment.observe() };
}
