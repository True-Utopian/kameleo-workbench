import type { ValidateFunction } from "ajv";

export type Truth = boolean | "unknown";
export type Predicate =
  | { op: "urlEquals"; originRef: string; pathname: string }
  | { op: "visible" | "present" | "absent" | "enabled"; target: string }
  | {
      op: "textEquals";
      target: string;
      equals: string;
      normalizeWhitespace: boolean;
    }
  | { op: "attributeEquals"; target: string; name: string; equals: string };
export interface StateRule {
  title: string;
  actionable: boolean;
  require: Predicate[];
  forbid: Predicate[];
  support: { id: string; predicate: Predicate; weight: number }[];
  minEvidenceScore: number;
  refines?: string[];
}
export interface StateRegistry {
  schemaVersion: 1;
  id: string;
  version: string;
  originRefs: string[];
  targets: Record<
    string,
    { selector: string; frame: "main"; cardinality: "one" | "many" }
  >;
  states: Record<string, StateRule>;
  policy: {
    sampleIntervalMs: number;
    observationTimeoutMs: number;
    maxObservationAgeMs: number;
    stableSamples: number;
    stableForMs: number;
    blankGraceMs: number;
    unknownTimeoutMs: number;
    overlap: "abstain-unless-refinement";
  };
}
export interface Observation {
  id: string;
  sequence: number;
  documentEpoch: string;
  observedAt: number;
  completedAt: number;
  originRef?: string;
  pathname?: string;
  complete: boolean;
  blank: boolean;
  supported: boolean;
  evidence: Record<string, Truth>;
  digest: string;
}
export interface StateEvidence {
  stateId: string;
  require: Truth[];
  forbid: Truth[];
  score: number;
  qualified: boolean;
  inheritedFrom?: string[];
  suppressedBy?: string[];
}
export interface Recognition {
  status:
    | "matched"
    | "settling"
    | "blank"
    | "unknown"
    | "ambiguous"
    | "unsupported"
    | "invalidated";
  actionable: boolean;
  stateId?: string;
  observation: Observation;
  score?: number;
  candidates: { stateId: string; score: number }[];
  evidenceLog: StateEvidence[];
  reason?: string;
}
export type ValueRef =
  | { source: "input" | "answer" | "capture"; key: string }
  | { source: "literal"; value: string };
export type Operation =
  | { op: "fill"; target: string; value: ValueRef }
  | { op: "click"; target: string; effect: "navigation" | "mutation" }
  | { op: "navigate"; originRef: string; pathname: string }
  | { op: "wait" }
  | { op: "chooseOption"; choiceSource: string; answerKey: string }
  | {
      op: "scrape";
      target: string;
      read: { kind: "text" } | { kind: "attribute"; name: string };
      outputKey: string;
      sensitivity: "public" | "sensitive";
      maxLength: number;
    }
  | {
      op: "bindIdentity";
      resolver: string;
      expected: ValueRef;
      receiptKey: string;
    };
export type Retry =
  | { mode: "never"; maxAttempts: 1 }
  | {
      mode: "safe-repeat";
      maxAttempts: number;
      backoffMs: number;
      justification: string;
    }
  | {
      mode: "reconcile";
      maxAttempts: number;
      backoffMs: number;
      resolver: string;
    };
export type Routes = Record<string, string>;
interface Recoverable {
  requires: string[];
  onError: string;
  onTimeout: string;
  onUncertain: string;
  recoveryByState: Routes;
}
export interface ActionStep extends Recoverable {
  kind: "action";
  do: Operation;
  postcondition: { states: string[]; require: Predicate[]; timeoutMs: number };
  next: Routes;
  retry: Retry;
}
export interface InputStep extends Recoverable {
  kind: "input";
  title: string;
  answerKey: string;
  input:
    | { kind: "choice"; choiceSource: string }
    | { kind: "text"; secret: boolean; minLength: number; maxLength: number };
  timeoutMs: number;
  next: Routes;
}
export interface ReviewStep {
  kind: "review";
  requires: string[];
  title: string;
  reasonCode: string;
  timeoutMs: number;
  recoveryByState: Routes;
}
export interface CompleteStep {
  kind: "complete";
  requires: string[];
  mode: "save" | "await-operator-then-save";
  identityReceipt?: string;
}
export type FlowStep = ActionStep | InputStep | ReviewStep | CompleteStep;
export interface ChoiceSource {
  states: string[];
  container: string;
  optionSelector: string;
  keyAttribute: string;
  labelAttribute: string;
  maxOptions: number;
  ttlMs: number;
  onStale: string;
  onAllUnavailable: string;
  patterns: {
    id: string;
    type: string;
    match:
      | { keyEquals: string; keyPattern?: never }
      | { keyPattern: string; keyEquals?: never };
    supported: boolean;
    availableWhen: { attribute: string; equals: string }[];
    unavailableReason: string;
  }[];
}
export interface FlowPack {
  schemaVersion: 1;
  id: string;
  title: string;
  version: string;
  registry: StateRegistry;
  inputSchema: {
    type?: string;
    properties?: Record<string, Record<string, unknown>>;
    required?: string[];
    [key: string]: unknown;
  };
  start: { originRef: string; pathname: string };
  limits: {
    maxSteps: number;
    maxTotalMs: number;
    maxStateVisits: number;
    maxInputRequests: number;
    maxReconciliations: number;
  };
  entryByState: Routes;
  choices: Record<string, ChoiceSource>;
  steps: Record<string, FlowStep>;
  onUnexpected: "pause-for-review" | "fail-preserve-profile";
  onUnexpectedStep: string;
  execution: { profilePolicyId: string; proxyPolicyId: string };
  identityPolicy: "anonymous" | "required";
  evidence: {
    mode: "structured-redacted";
    screenshots: "off" | "masked-on-failure";
    retentionDays: number;
  };
}
export interface FlowManifest {
  origins: Record<string, string>;
  profilePolicyIds: string[];
  proxyPolicyIds: string[];
  identityResolvers?: string[];
  reconciliationResolvers?: string[];
  safeRepeatTargets?: string[];
  safeNavigationPaths?: string[];
  identityPolicy?: "anonymous" | "required";
}
export interface CompiledFlow {
  pack: FlowPack;
  manifest: FlowManifest;
  hash: string;
  validateInputs: ValidateFunction;
  predicates: Predicate[];
}
export interface FlowEvent {
  type: string;
  time: number;
  runId: string;
  stepId?: string;
  stateId?: string;
  actionId?: string;
  reason?: string;
  score?: number;
  status?: string;
  evidence?: StateEvidence[];
}
export interface FlowSnapshot {
  version: 1;
  runId: string;
  packHash: string;
  revision: number;
  startedAt: number;
  updatedAt: number;
  stepId?: string;
  status: "running" | "review" | "completed" | "failed";
  steps: number;
  inputRequests: number;
  reconciliations: number;
  visits: Record<string, number>;
  attempts: Record<string, number>;
  pending?: {
    id: string;
    stepId: string;
    attempt: number;
    phase: "intent" | "dispatched" | "uncertain";
  };
  lastEvent?: FlowEvent;
  completionMode?: "save" | "await-operator-then-save";
}
/** save must atomically persist the snapshot before resolving. The coordinator fences writers. */
export interface FlowJournal {
  load(runId: string): Promise<FlowSnapshot | null>;
  save(snapshot: FlowSnapshot): Promise<void>;
}
export interface ChoiceOption {
  key: string;
  label: string;
  type: string;
  available: boolean;
  reason?: string;
  identity: string;
}
export interface FlowDriver {
  observe(): Promise<Observation>;
  navigate(
    url: string,
    guard?: () => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void>;
  fill(
    target: string,
    value: string,
    guard: () => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void>;
  click(
    target: string,
    guard: () => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void>;
  scrape(
    operation: Extract<Operation, { op: "scrape" }>,
    guard: () => Promise<void>,
    signal?: AbortSignal,
  ): Promise<string>;
  choices(source: ChoiceSource): Promise<ChoiceOption[]>;
  choose(
    source: ChoiceSource,
    option: ChoiceOption,
    guard: () => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void>;
  dispose?(): void;
}
export interface ResolverContext {
  runId: string;
  signal: AbortSignal;
}
export interface IdentityResolver {
  bind(expected: string, context: ResolverContext): Promise<string>;
  verify(receipt: string, context: ResolverContext): Promise<boolean>;
}
export interface FlowContext {
  runId: string;
  inputs: Record<string, unknown>;
  driver: FlowDriver;
  journal: FlowJournal;
  signal?: AbortSignal;
  requestInput(
    title: string,
    fields: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>>;
  identityResolvers?: Record<string, IdentityResolver>;
  reconciliationResolvers?: Record<
    string,
    (
      pending: NonNullable<FlowSnapshot["pending"]>,
      context: ResolverContext,
    ) => Promise<"applied" | "not-applied" | "unknown">
  >;
  checkpoint?: () => Promise<void>;
  onEvent?: (event: FlowEvent) => void;
  /** Runs after an observed action is durable and before any subsequent step. */
  afterAction?: (
    snapshot: FlowSnapshot,
    operation: Operation,
  ) => Promise<"continue" | "handoff">;
  /** Reattach only after coordinator ownership/profile reconciliation. Default resumes in review. */
  resume?: boolean;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}
