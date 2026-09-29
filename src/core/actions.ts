export type SemanticTarget =
  | { by: "role"; role: string; name?: string }
  | { by: "label"; label: string }
  | { by: "text"; text: string }
  | { by: "testId"; id: string }
  | { by: "css"; selector: string };

export type QAAction =
  | { type: "navigate"; url: string }
  | { type: "click"; target: SemanticTarget | { by: "coordinates"; x: number; y: number } }
  | { type: "fill"; target: SemanticTarget; value: string }
  | { type: "select"; target: SemanticTarget; value: string }
  | { type: "press"; target: SemanticTarget; key: string }
  | { type: "scroll"; deltaY: number; deltaX?: number }
  | { type: "screenshot"; path: string };

export type QAExecutionAction = QAAction | { type: "inspect"; target: SemanticTarget } | { type: "wait"; milliseconds: number; reason?: "pending_click" } | { type: "done"; reason: string };

export type QAActionOutcome =
  | { success: true }
  | { success: false; error: string };
