export type JsonObject = Record<string, unknown>;
export interface SqlResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount?: number | null;
}
export interface SqlExecutor {
  query<T = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<SqlResult<T>>;
}
export interface SqlDatabase extends SqlExecutor {
  transaction<T>(body: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  close?(): Promise<void>;
}
export interface WorkspaceConfig {
  tenantId: string;
  tenantName?: string;
  siteId: string;
  origin: string;
  quotaDomainId: string;
  vendorTeamKey: string;
  totalBrowserBudget: number;
  mobileBrowserBudget?: number;
  countedRpm?: number;
  nodeId: string;
  nodeIncarnationId: string;
  engineProcessKey: string;
  workspaceKey?: string;
  nodeMaxBrowsers?: number;
}
export interface PackReference {
  key: string;
  version: string;
  hash: string;
  artifactKey: string;
}
export interface SubmitFlow {
  tenantId: string;
  siteId: string;
  quotaDomainId: string;
  nodeId: string;
  pack: PackReference;
  requestId: string;
  deadlineAt: string;
  flowId?: string;
  mobile?: boolean;
  identityId?: string;
  metadata?: JsonObject;
}
export interface FlowRecord {
  id: string;
  tenantId: string;
  siteId: string;
  quotaDomainId: string;
  nodeId: string;
  profileId: string;
  attachmentId: string;
  kameleoProfileId?: string;
  identityId?: string;
  bindingId?: string;
  state: string;
  waitReason?: string;
  createdAt: string;
  updatedAt: string;
  deadlineAt: string;
  requestId: string;
  pack: PackReference;
  metadata: JsonObject;
  checkpoint: JsonObject;
  revision: number;
}
export interface LeaseGrant {
  id: string;
  tenantId: string;
  flowId: string;
  attachmentId: string;
  profileId: string;
  quotaDomainId: string;
  nodeId: string;
  nodeIncarnationId: string;
  epoch: number;
  expiresAt: string;
  state: string;
  capacityReleased: boolean;
  released: boolean;
  identityId?: string;
  bindingId?: string;
  kameleoProfileId?: string;
}
export type OperationKind =
  | "create"
  | "install"
  | "start"
  | "attach"
  | "stop"
  | "export"
  | "import"
  | "update"
  | "upgrade";
export interface LifecycleOperation {
  id: string;
  leaseId: string;
  sequence: number;
  kind: OperationKind;
  state: string;
  deadlineAt: string;
  recoveryTag?: string;
  resolvedAt?: string;
  vendorErrorCode?: string;
}
export interface StopProof {
  kind:
    | "never_dispatched"
    | "no_browser_started"
    | "drained_and_stopped"
    | "isolation_fenced";
  evidenceDigest: string;
  localSequence: number;
  coversLifecycleSequence: number;
}
export interface VerifiedIdentity {
  issuer: string;
  subjectKey: string;
  hmacKeyVersion: number;
  nonceDigest: string;
  assertionDigest: string;
  verifiedAt: string;
  expiresAt: string;
}
export interface BindingResult {
  operationId: string;
  state: "adopted" | "switch_pending" | "switched" | "blocked";
  identityId: string;
  bindingId: string;
  profileId: string;
}
export interface SnapshotInput {
  id?: string;
  exportOperationId: string;
  objectKey: string;
  sha256: string;
  bytes: number;
  engineVersion: string;
  kernelVersion: string;
}
export interface SnapshotRecord {
  id: string;
  profileId: string;
  generation: number;
  state: string;
  objectKey: string;
  sha256?: string;
  bytes?: number;
}
export interface ProfileRecord {
  id: string;
  tenantId: string;
  kameleoProfileId?: string;
  state: string;
  revision: number;
  leaseEpoch: number;
  snapshotGeneration: number;
  metadata: JsonObject;
  snapshot?: SnapshotRecord;
}
export interface CoordinatorStats {
  chargedBrowsers: number;
  chargedMobile: number;
  heldProfiles: number;
  quarantinedLeases: number;
  queuedFlows: number;
  pendingOperations: number;
  totalBrowserBudget: number;
  mobileBrowserBudget: number;
  startsBlockedUntil: string | null;
}
export class CoordinatorError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode = 409,
  ) {
    super(message);
    this.name = "CoordinatorError";
  }
}
