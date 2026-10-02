import type { Page } from "puppeteer-core";
import type { Actions, PacePreset } from "../actions.js";

export type FieldPolicy = "sensitive" | "ordinary" | "synthetic-free-text";
export interface TimingGroup {
  count: number;
  mean: [number, number];
  covariance: [number, number, number];
}
export interface InteractionModel {
  schemaVersion: 1;
  version: string;
  calibrated: boolean;
  deviceClass: string;
  keyboardLayout: string;
  global: TimingGroup;
  transitions: Record<string, TimingGroup>;
  digraphs: Record<string, TimingGroup>;
  trainingParticipants: string[];
  trainingSessions: string[];
}
export interface TypingOptions {
  seed: string;
  model?: InteractionModel;
  rollover?: boolean;
  fatigue?: boolean;
  activeTypingMs?: number;
  fieldPolicy?: FieldPolicy;
  corrections?: boolean;
  correctionProbability?: number;
}
export interface KeyPrimitive {
  atMs: number;
  kind: "down" | "up" | "insert";
  key: string;
}
export interface TypingPlan {
  events: KeyPrimitive[];
  durationMs: number;
  activeTypingMs: number;
  corrections: number;
  constrainedIntervals: number;
}
export interface Point {
  x: number;
  y: number;
}
export interface PointerSample extends Point {
  atMs: number;
}
export interface TargetBox extends Point {
  width: number;
  height: number;
}
export interface SynthesizedActionOptions {
  seed: string;
  allowedOrigins: string[];
  model?: InteractionModel;
  signal?: AbortSignal;
  checkpoint?: () => Promise<void>;
  fieldPolicy?: (selector: string) => FieldPolicy;
  corrections?: boolean;
  rollover?: boolean;
  fatigue?: boolean;
  timeoutMs?: number;
  preset?: PacePreset;
  beforeDispatch?: (action: {
    kind: "click" | "key" | "insert" | "clear" | "goto" | "scroll" | "pointer";
    selector?: string;
  }) => Promise<void>;
}
export interface SynthesizedActions extends Actions {
  scroll(selector: string, deltaY: number): Promise<void>;
  focus(selector: string): Promise<void>;
  useModel(model: InteractionModel): void;
}
export interface TraceEvent {
  atMs: number;
  kind: "keydown" | "keyup" | "pointer" | "scroll";
  key?: string;
  field?: string;
  x?: number;
  y?: number;
  deltaY?: number;
}
export interface TraceAssertions {
  correctValue: boolean;
  correctFocus: boolean;
  noDuplicateSubmit: boolean;
  noSecretCapture: boolean;
  keysReleased: boolean;
}
export interface InteractionTrace {
  schemaVersion: 1;
  source: "human" | "synthetic";
  split: "train" | "development" | "holdout";
  consent: { granted: true; purpose: "owned-site-synthetic-testing" };
  syntheticTask: true;
  participantId: string;
  sessionId: string;
  taskId: string;
  deviceClass: string;
  keyboardLayout: string;
  events: TraceEvent[];
  assertions: TraceAssertions;
}
export type RecorderOptions = Omit<
  InteractionTrace,
  "events" | "assertions" | "schemaVersion"
> & { allowedOrigins: string[]; maxEvents?: number };
export interface Recorder {
  stop(assertions: TraceAssertions): Promise<InteractionTrace>;
}
export type BrowserPage = Page;
