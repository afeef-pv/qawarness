export type Platform = "web" | "android" | "ios";

export interface QAElement {
  id?: string;
  role?: string;
  text?: string;
  label?: string;

  visible: boolean;
  enabled: boolean;
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
}

export interface QAEnvironment {
  start(): Promise<void>;

  act(action: QAAction): Promise<QAActionOutcome>;

  navigate(url: string): Promise<void>;

  observe(): Promise<QAObservation>;

  screenshot(path: string): Promise<void>;

  close(): Promise<void>;
}
import type { QAAction, QAActionOutcome } from "./actions";
