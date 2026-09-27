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
  tool("click", "Click a semantic target", { target }, ["target"]),
  tool("fill", "Fill an input", { target, value: { type: "string" } }, ["target", "value"]),
  tool("select", "Select an option by value", { target, value: { type: "string" } }, ["target", "value"]),
  tool("press", "Press a key on a target", { target, key: { type: "string" } }, ["target", "key"]),
  tool("scroll", "Scroll page in pixels", { deltaY: { type: "number" }, deltaX: { type: "number" } }, ["deltaY"]),
  tool("inspect", "Inspect matching elements for current state", { target }, ["target"]),
  tool("done", "Task appears complete; start independent verification", { reason: { type: "string" } }, ["reason"]),
];
export function parseAgentAction(name: string, v: unknown): QAExecutionAction {
  if (!object(v)) throw new Error("tool arguments must be an object");
  switch (name) {
    case "navigate": { if (typeof v.url !== "string" || !/^https?:\/\//.test(v.url)) break; return { type: "navigate", url: v.url }; }
    case "click": { if (object(v.target) && v.target.by === "coordinates") { if (typeof v.target.x === "number" && Number.isFinite(v.target.x) && typeof v.target.y === "number" && Number.isFinite(v.target.y)) return { type: "click", target: { by: "coordinates", x: v.target.x, y: v.target.y } }; break; } return { type: "click", target: parseTarget(v.target) }; }
    case "fill": case "select": if (typeof v.value === "string") return { type: name, target: parseTarget(v.target), value: v.value }; break;
    case "press": if (typeof v.key === "string" && v.key.trim()) return { type: "press", target: parseTarget(v.target), key: v.key }; break;
    case "scroll": if (typeof v.deltaY === "number" && Number.isFinite(v.deltaY) && (v.deltaX === undefined || typeof v.deltaX === "number" && Number.isFinite(v.deltaX))) return { type: "scroll", deltaY: v.deltaY, ...(v.deltaX === undefined ? {} : { deltaX: v.deltaX }) }; break;
    case "inspect": return { type: "inspect", target: parseTarget(v.target) };
    case "done": if (typeof v.reason === "string" && v.reason.trim()) return { type: "done", reason: v.reason }; break;
  }
  throw new Error(`invalid arguments for ${name}`);
}
export function summarizeObservation(o: QAObservation): string {
  const elements = o.elements.filter(e => e.visible).slice(0, 80).map(e => `[${e.role ?? "element"}] ${JSON.stringify((e.label ?? e.text ?? "").slice(0, 120))}${e.id ? ` id=${e.id}` : ""}${e.enabled ? "" : " disabled"}`).join("\n");
  return `URL: ${(o.location.url ?? "").slice(0, 1000)}\nTitle: ${(o.location.title ?? "").slice(0, 300)}\nVisible text:\n${o.text.slice(0, 8000)}\nInteractive elements:\n${elements}\nErrors:\n${o.errors.slice(-10).map(error => error.slice(0, 500)).join("\n")}`;
}
export interface AgentResult { status: "done" | "max_steps" | "agent_protocol_error"; completionReason?: string; steps: number; finalObservation: QAObservation }
export async function runAgent(scenario: QAScenario, environment: QAEnvironment, provider: LLMProvider, executor: QAExecutor): Promise<AgentResult> {
  let observation = await environment.observe();
  const messages: LLMMessage[] = [
    { role: "system", content: "You execute a QA task in a web app. Use only one provided tool per turn. Prefer role/name, then label, text, testId, CSS, coordinates. Inspect before guessing. Recover from ordinary action failures. Call done when you believe the task is complete; prose is not completion. Avoid unnecessary actions." },
    { role: "user", content: `Instruction:\n${scenario.instruction}\n\nCurrent state:\n${summarizeObservation(observation)}` },
  ];
  let steps = 0;
  let protocolErrors = 0;
  while (steps < scenario.maxSteps) {
    const response = await provider.generate({ messages, tools: QA_TOOLS, temperature: 0 });
    const calls = response.toolCalls ?? [];
    if (calls.length !== 1) {
      if (++protocolErrors >= 3) return { status: "agent_protocol_error", steps, finalObservation: observation };
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
      if (++protocolErrors >= 3) return { status: "agent_protocol_error", steps, finalObservation: observation };
      continue;
    }
    steps++;
    const record: ExecutionRecord = await executor.execute(action);
    if (action.type === "done") return { status: "done", completionReason: action.reason, steps, finalObservation: observation };
    observation = record.observation ?? await environment.observe();
    result = JSON.stringify({ status: record.status, error: record.error, inspection: record.inspection, observation: summarizeObservation(observation) });
    messages.push({ role: "tool", toolCallId: call.id, content: result });
  }
  return { status: "max_steps", steps, finalObservation: await environment.observe() };
}
