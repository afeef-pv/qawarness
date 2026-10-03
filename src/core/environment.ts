export type Platform = "web" | "android" | "ios";

export interface QAElement {
  id?: string;
  role?: string;
  text?: string;
  label?: string;
  value?: string;

  visible: boolean;
  enabled: boolean;
}

export interface QADiagnostic {
  schemaVersion: 1;
  id: string;
  source: "application";
  occurredAt: string;
  kind: "http_error" | "transport_failure" | "console_error" | "page_error";
  message: string;
  request?: { id: string; startedAt: string; method: string; url: string; status?: number };
}

export interface QAObservation {
  platform: Platform;

  location: {
    url?: string;
    title?: string;
    route?: string;
  };

  text: string;

  elements: QAElement[];

  screenshot?: string;

  errors: string[];
  diagnostics?: QADiagnostic[];
  screenshotCapturedAt?: string;
}

export interface QAEnvironment {
  start(): Promise<void>;

  act(action: QAAction): Promise<QAActionOutcome>;

  navigate(url: string): Promise<void>;

  observe(): Promise<QAObservation>;
  inspect(target: import("./actions").SemanticTarget): Promise<{ count: number; elements: QAElement[] }>;

  screenshot(path: string): Promise<void>;

  runtimeInfo?(): Promise<{ version?: string; viewport?: { width: number; height: number } }>;

  close(): Promise<void>;
}
import type { QAAction, QAActionOutcome } from "./actions";
