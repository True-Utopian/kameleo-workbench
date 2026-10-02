import { randomUUID, createHash } from "node:crypto";
import { isIP } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { initialMigration } from "./migrations/001-initial.js";
import {
  CoordinatorError,
  type SqlDatabase,
  type SqlExecutor,
  type WorkspaceConfig,
  type SubmitFlow,
  type FlowRecord,
  type LeaseGrant,
  type LifecycleOperation,
  type OperationKind,
  type StopProof,
  type VerifiedIdentity,
  type BindingResult,
  type SnapshotInput,
  type SnapshotRecord,
  type ProfileRecord,
  type CoordinatorStats,
  type JsonObject,
} from "./types.js";
export * from "./types.js";
export { PgDatabase } from "./database.js";

type Row = Record<string, any>;
const iso = (value: Date | string) => new Date(value).toISOString();
const number = (value: unknown) => Number(value);
const digest = (value: string) => {
  if (!/^[a-f0-9]{64}$/i.test(value))
    throw new CoordinatorError(
      "Expected a SHA-256 hex digest",
      "invalid_digest",
      400,
    );
  return Buffer.from(value, "hex");
};
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const json = (value: unknown) => JSON.stringify(value ?? {});
const error = (message: string, code: string, status = 409): never => {
  throw new CoordinatorError(message, code, status);
};
const one = async (
  tx: SqlExecutor,
  sql: string,
  args: unknown[] = [],
): Promise<Row | undefined> => (await tx.query<Row>(sql, args)).rows[0];
const extraMigration = `
CREATE TABLE flow_assignments (
 tenant_id uuid NOT NULL, flow_id uuid NOT NULL, quota_domain_id uuid NOT NULL, node_id uuid NOT NULL,
 mobile boolean NOT NULL DEFAULT false,
 PRIMARY KEY(tenant_id,flow_id),
 FOREIGN KEY(tenant_id,flow_id) REFERENCES flow_instances(tenant_id,id),
 FOREIGN KEY(tenant_id,node_id,quota_domain_id) REFERENCES engine_nodes(tenant_id,id,quota_domain_id)
);
CREATE TABLE flow_runtime_data (
 tenant_id uuid NOT NULL, flow_id uuid NOT NULL,
 metadata jsonb NOT NULL DEFAULT '{}', checkpoint jsonb NOT NULL DEFAULT '{}', revision bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(tenant_id,flow_id), FOREIGN KEY(tenant_id,flow_id) REFERENCES flow_instances(tenant_id,id),
 CHECK(jsonb_typeof(metadata)='object'), CHECK(jsonb_typeof(checkpoint)='object')
);
CREATE TABLE flow_events (
 sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 tenant_id uuid NOT NULL, flow_id uuid NOT NULL, event jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,flow_id) REFERENCES flow_instances(tenant_id,id)
);
CREATE INDEX flow_events_lookup ON flow_events(tenant_id,flow_id,sequence);
CREATE TABLE quota_tenant_fairness (
 quota_domain_id uuid NOT NULL,tenant_id uuid NOT NULL,virtual_finish numeric NOT NULL DEFAULT 0,
 PRIMARY KEY(quota_domain_id,tenant_id),
 FOREIGN KEY(tenant_id,quota_domain_id) REFERENCES tenant_quota_domains(tenant_id,quota_domain_id)
);
ALTER TABLE flow_instances DROP CONSTRAINT flow_instances_state_check;
ALTER TABLE flow_instances ADD CHECK(state IN ('queued','preparing','starting','running','awaiting_input','paused','recovering','saving','saved','failed','cancelled','interrupted','export_failed','review','completed'));
ALTER TABLE logical_profiles ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(metadata)='object');
ALTER TABLE profile_snapshots ADD COLUMN expected_profile_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE profile_snapshots ADD COLUMN expected_predecessor_generation bigint NOT NULL DEFAULT 0;
ALTER TABLE browser_leases ADD UNIQUE(tenant_id,id,quota_domain_id);
CREATE TABLE proxy_exit_claims(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,lease_id uuid NOT NULL,quota_domain_id uuid NOT NULL,
 exit_ip inet NOT NULL,report jsonb NOT NULL DEFAULT '{}',claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),released_at timestamptz,
 FOREIGN KEY(tenant_id,lease_id,quota_domain_id) REFERENCES browser_leases(tenant_id,id,quota_domain_id),
 CHECK(masklen(exit_ip)=CASE WHEN family(exit_ip)=4 THEN 32 ELSE 128 END),CHECK(jsonb_typeof(report)='object')
);
CREATE UNIQUE INDEX one_active_exit_per_domain ON proxy_exit_claims(quota_domain_id,exit_ip) WHERE released_at IS NULL;
CREATE UNIQUE INDEX one_active_exit_per_lease ON proxy_exit_claims(tenant_id,lease_id) WHERE released_at IS NULL;
`;

/** Durable state only. Engine/process evidence must come from the exclusive node agent. */
export class DurableCoordinator {
  readonly db: SqlDatabase;
  constructor(options: { db: SqlDatabase }) {
    this.db = options.db;
  }
  private async tx<T>(body: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.db.transaction(async (tx) => {
          await tx.query(
            "SET LOCAL search_path = workbench_coordinator, pg_catalog",
          );
          return body(tx);
        });
      } catch (cause) {
        if (
          attempt >= 3 ||
          !["40001", "40P01"].includes((cause as { code?: string }).code ?? "")
        )
          throw cause;
        await delay(5 * 2 ** attempt + Math.floor(Math.random() * 10));
      }
    }
  }
  async migrate(): Promise<void> {
    await this.tx(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(774201991)");
      await tx.query("CREATE SCHEMA IF NOT EXISTS workbench_coordinator");
      await tx.query(
        "CREATE TABLE IF NOT EXISTS workbench_coordinator.schema_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())",
      );
      if (
        !(await one(
          tx,
          "SELECT version FROM schema_migrations WHERE version=1",
        ))
      ) {
        await tx.query(initialMigration);
        await tx.query(extraMigration);
        await tx.query("INSERT INTO schema_migrations(version) VALUES(1)");
      }
    });
  }
  async ensureWorkspace(
    c: WorkspaceConfig,
  ): Promise<{ nodeReady: boolean; agentEpoch: number }> {
    return this.tx(async (tx) => {
      await tx.query(
        "INSERT INTO tenants(id,name) VALUES($1,$2) ON CONFLICT(id) DO NOTHING",
        [c.tenantId, c.tenantName ?? "Workbench"],
      );
      await tx.query(
        `INSERT INTO quota_domains(id,vendor_team_key,total_browser_budget,mobile_browser_budget,counted_requests_per_minute)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING`,
        [
          c.quotaDomainId,
          c.vendorTeamKey,
          c.totalBrowserBudget,
          c.mobileBrowserBudget ?? 0,
          c.countedRpm ?? 120,
        ],
      );
      const domain = await one(
        tx,
        "SELECT * FROM quota_domains WHERE id=$1 FOR UPDATE",
        [c.quotaDomainId],
      );
      if (domain?.vendor_team_key !== c.vendorTeamKey)
        error(
          "Quota domain belongs to a different provider team",
          "quota_domain_conflict",
        );
      await tx.query(
        "INSERT INTO tenant_quota_domains VALUES($1,$2) ON CONFLICT DO NOTHING",
        [c.tenantId, c.quotaDomainId],
      );
      await tx.query(
        "INSERT INTO quota_tenant_fairness(quota_domain_id,tenant_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [c.quotaDomainId, c.tenantId],
      );
      await tx.query(
        "INSERT INTO owned_sites(tenant_id,id,origin) VALUES($1,$2,$3) ON CONFLICT(tenant_id,id) DO NOTHING",
        [c.tenantId, c.siteId, c.origin],
      );
      const site = await one(
        tx,
        "SELECT origin FROM owned_sites WHERE tenant_id=$1 AND id=$2",
        [c.tenantId, c.siteId],
      );
      if (site?.origin !== c.origin)
        error("Site origin is immutable", "site_conflict");
      await tx.query(
        `INSERT INTO engine_nodes(tenant_id,id,quota_domain_id,workspace_key,max_browsers)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,id) DO NOTHING`,
        [
          c.tenantId,
          c.nodeId,
          c.quotaDomainId,
          c.workspaceKey ?? c.nodeId,
          c.nodeMaxBrowsers ?? 1,
        ],
      );
      const node = await one(
        tx,
        "SELECT * FROM engine_nodes WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [c.tenantId, c.nodeId],
      );
      if (node?.quota_domain_id !== c.quotaDomainId)
        error(
          "Node quota domain cannot be changed implicitly",
          "node_conflict",
        );
      let incarnation = await one(
        tx,
        "SELECT * FROM node_incarnations WHERE tenant_id=$1 AND id=$2",
        [c.tenantId, c.nodeIncarnationId],
      );
      if (
        incarnation &&
        (incarnation.node_id !== c.nodeId ||
          incarnation.engine_process_key !== c.engineProcessKey)
      )
        error("Incarnation identity cannot be reused", "incarnation_conflict");
      if (!incarnation) {
        const updated = await one(
          tx,
          "UPDATE engine_nodes SET agent_epoch=agent_epoch+1,state='recovering' WHERE tenant_id=$1 AND id=$2 RETURNING agent_epoch",
          [c.tenantId, c.nodeId],
        );
        incarnation = await one(
          tx,
          `INSERT INTO node_incarnations(tenant_id,id,node_id,agent_epoch,engine_process_key,heartbeat_at)
          VALUES($1,$2,$3,$4,$5,clock_timestamp()) RETURNING *`,
          [
            c.tenantId,
            c.nodeIncarnationId,
            c.nodeId,
            updated!.agent_epoch,
            c.engineProcessKey,
          ],
        );
        await tx.query(
          `UPDATE browser_leases SET state='quarantined' WHERE tenant_id=$1 AND node_id=$2 AND node_incarnation_id<>$3 AND released_at IS NULL`,
          [c.tenantId, c.nodeId, c.nodeIncarnationId],
        );
      }
      const old = await one(
        tx,
        "SELECT 1 FROM browser_leases WHERE tenant_id=$1 AND node_id=$2 AND released_at IS NULL AND node_incarnation_id<>$3 LIMIT 1",
        [c.tenantId, c.nodeId, c.nodeIncarnationId],
      );
      const current =
        number(incarnation!.agent_epoch) ===
        number(
          (await one(
            tx,
            "SELECT agent_epoch FROM engine_nodes WHERE tenant_id=$1 AND id=$2",
            [c.tenantId, c.nodeId],
          ))!.agent_epoch,
        );
      if (!old && current)
        await tx.query(
          "UPDATE engine_nodes SET state='ready' WHERE tenant_id=$1 AND id=$2 AND state='recovering'",
          [c.tenantId, c.nodeId],
        );
      return {
        nodeReady: !old && current,
        agentEpoch: number(incarnation!.agent_epoch),
      };
    });
  }
  async markNodeReady(
    tenantId: string,
    nodeId: string,
    incarnationId: string,
  ): Promise<void> {
    await this.tx(async (tx) => {
      const node = await one(
        tx,
        "SELECT * FROM engine_nodes WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [tenantId, nodeId],
      );
      const inc = await one(
        tx,
        "SELECT * FROM node_incarnations WHERE tenant_id=$1 AND id=$2 AND node_id=$3",
        [tenantId, incarnationId, nodeId],
      );
      if (
        !node ||
        !inc ||
        number(node.agent_epoch) !== number(inc.agent_epoch) ||
        inc.fenced_at
      )
        error("Node incarnation is stale", "stale_incarnation");
      if (!["ready", "recovering"].includes(node!.state))
        error("Node is administratively unavailable", "node_unavailable");
      if (
        await one(
          tx,
          "SELECT 1 FROM browser_leases WHERE tenant_id=$1 AND node_id=$2 AND node_incarnation_id<>$3 AND released_at IS NULL LIMIT 1",
          [tenantId, nodeId, incarnationId],
        )
      )
        error("Old holders require reconciliation", "node_quarantined");
      await tx.query(
        "UPDATE engine_nodes SET state='ready' WHERE tenant_id=$1 AND id=$2",
        [tenantId, nodeId],
      );
    });
  }
  async submitFlow(input: SubmitFlow): Promise<FlowRecord> {
    const id = input.flowId ?? randomUUID();
    await this.tx(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `submit:${input.tenantId}:${input.requestId}`,
      ]);
      const previous = await one(
        tx,
        "SELECT id,pack_content_sha256 FROM flow_instances WHERE tenant_id=$1 AND submit_idempotency_key=$2",
        [input.tenantId, input.requestId],
      );
      if (previous) {
        if (
          Buffer.from(previous.pack_content_sha256).toString("hex") !==
          input.pack.hash.toLowerCase()
        )
          error("Request key was used with another pack", "request_conflict");
        return;
      }
      const node = await one(
        tx,
        "SELECT * FROM engine_nodes WHERE tenant_id=$1 AND id=$2 AND quota_domain_id=$3",
        [input.tenantId, input.nodeId, input.quotaDomainId],
      );
      if (!node)
        error(
          "Assigned node not registered for this team",
          "node_not_found",
          404,
        );
      const pack = await one(
        tx,
        `INSERT INTO site_pack_versions(tenant_id,id,site_id,pack_key,version,content_sha256,artifact_key)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(tenant_id,pack_key,version) DO UPDATE SET pack_key=EXCLUDED.pack_key RETURNING *`,
        [
          input.tenantId,
          randomUUID(),
          input.siteId,
          input.pack.key,
          input.pack.version,
          digest(input.pack.hash),
          input.pack.artifactKey,
        ],
      );
      if (
        pack!.site_id !== input.siteId ||
        Buffer.from(pack!.content_sha256).toString("hex") !==
          input.pack.hash.toLowerCase()
      )
        error("Pack versions are immutable", "pack_version_conflict");
      let binding: Row | undefined;
      let profileId = randomUUID();
      if (input.identityId) {
        const identity = await one(
          tx,
          "SELECT * FROM identities WHERE tenant_id=$1 AND id=$2 AND site_id=$3 FOR UPDATE",
          [input.tenantId, input.identityId, input.siteId],
        );
        if (!identity || identity.tombstoned_at || identity.state !== "ready")
          error("Identity is unavailable", "identity_unavailable");
        binding = await one(
          tx,
          "SELECT * FROM identity_bindings WHERE tenant_id=$1 AND identity_id=$2 AND retired_at IS NULL",
          [input.tenantId, input.identityId],
        );
        if (!binding)
          error("Identity has no current profile", "binding_not_found", 404);
        profileId = binding!.profile_id;
        if (
          !(await one(
            tx,
            "SELECT 1 FROM profile_replicas WHERE tenant_id=$1 AND profile_id=$2 AND node_id=$3 AND role='authoritative' AND retired_at IS NULL",
            [input.tenantId, profileId, input.nodeId],
          ))
        )
          error(
            "Warm profile requires a controlled migration to this node",
            "migration_required",
          );
      } else {
        await tx.query(
          "INSERT INTO logical_profiles(tenant_id,id) VALUES($1,$2)",
          [input.tenantId, profileId],
        );
        await tx.query(
          "INSERT INTO profile_replicas(tenant_id,id,profile_id,node_id,role) VALUES($1,$2,$3,$4,'authoritative')",
          [input.tenantId, randomUUID(), profileId, input.nodeId],
        );
      }
      await tx.query(
        `INSERT INTO flow_instances(tenant_id,id,site_id,pack_id,pack_version,pack_content_sha256,submit_idempotency_key,absolute_deadline_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          input.tenantId,
          id,
          input.siteId,
          pack!.id,
          input.pack.version,
          digest(input.pack.hash),
          input.requestId,
          input.deadlineAt,
        ],
      );
      await tx.query(
        `INSERT INTO flow_session_attachments(tenant_id,id,flow_id,site_id,profile_id,identity_id,binding_id,bound_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,CASE WHEN $6::uuid IS NOT NULL THEN clock_timestamp() END)`,
        [
          input.tenantId,
          randomUUID(),
          id,
          input.siteId,
          profileId,
          input.identityId ?? null,
          binding?.id ?? null,
        ],
      );
      await tx.query("INSERT INTO flow_assignments VALUES($1,$2,$3,$4,$5)", [
        input.tenantId,
        id,
        input.quotaDomainId,
        input.nodeId,
        input.mobile ?? false,
      ]);
      await tx.query(
        "INSERT INTO flow_runtime_data(tenant_id,flow_id,metadata) VALUES($1,$2,$3::jsonb)",
        [input.tenantId, id, json(input.metadata)],
      );
    });
    return this.tx(async (tx) => {
      const stored = await one(
        tx,
        "SELECT id FROM flow_instances WHERE tenant_id=$1 AND submit_idempotency_key=$2",
        [input.tenantId, input.requestId],
      );
      return this.flow(tx, input.tenantId, stored!.id);
    });
  }
  private async flow(
    tx: SqlExecutor,
    tenantId: string,
    id: string,
  ): Promise<FlowRecord> {
    const r = await one(
      tx,
      `SELECT f.*,a.quota_domain_id,a.node_id,p.pack_key,p.artifact_key,d.metadata,d.checkpoint,d.revision AS data_revision,
      s.profile_id,s.id AS attachment_id,s.identity_id,s.binding_id,lp.kameleo_profile_id
      FROM flow_instances f JOIN flow_assignments a ON a.tenant_id=f.tenant_id AND a.flow_id=f.id
      JOIN site_pack_versions p ON p.tenant_id=f.tenant_id AND p.id=f.pack_id
      JOIN flow_runtime_data d ON d.tenant_id=f.tenant_id AND d.flow_id=f.id
      JOIN LATERAL(SELECT * FROM flow_session_attachments sa WHERE sa.tenant_id=f.tenant_id AND sa.flow_id=f.id ORDER BY (sa.closed_at IS NULL) DESC,sa.opened_at DESC LIMIT 1)s ON true
      JOIN logical_profiles lp ON lp.tenant_id=f.tenant_id AND lp.id=s.profile_id WHERE f.tenant_id=$1 AND f.id=$2`,
      [tenantId, id],
    );
    if (!r) return error("Flow not found", "flow_not_found", 404);
    return {
      id: r.id,
      tenantId: r.tenant_id,
      siteId: r.site_id,
      quotaDomainId: r.quota_domain_id,
      nodeId: r.node_id,
      profileId: r.profile_id,
      attachmentId: r.attachment_id,
      ...(r.kameleo_profile_id
        ? { kameleoProfileId: r.kameleo_profile_id }
        : {}),
      ...(r.identity_id
        ? { identityId: r.identity_id, bindingId: r.binding_id }
        : {}),
      state: r.state,
      waitReason: r.wait_reason ?? undefined,
      createdAt: iso(r.created_at),
      updatedAt: iso(r.updated_at),
      deadlineAt: iso(r.absolute_deadline_at),
      requestId: r.submit_idempotency_key,
      pack: {
        key: r.pack_key,
        version: r.pack_version,
        hash: Buffer.from(r.pack_content_sha256).toString("hex"),
        artifactKey: r.artifact_key,
      },
      metadata: r.metadata,
      checkpoint: r.checkpoint,
      revision: number(r.data_revision),
    };
  }
  async getFlow(tenantId: string, id: string) {
    return this.tx((tx) => this.flow(tx, tenantId, id));
  }
  async listFlows(
    tenantId: string,
    filter: { nodeId?: string } = {},
  ): Promise<FlowRecord[]> {
    return this.tx(async (tx) => {
      const rows = await tx.query<Row>(
        "SELECT flow_id FROM flow_assignments WHERE tenant_id=$1 AND ($2::uuid IS NULL OR node_id=$2)",
        [tenantId, filter.nodeId ?? null],
      );
      const flows: FlowRecord[] = [];
      for (const r of rows.rows)
        flows.push(await this.flow(tx, tenantId, r.flow_id));
      return flows;
    });
  }
  async setFlowStatus(
    tenantId: string,
    flowId: string,
    state: string,
    waitReason?: string,
  ): Promise<void> {
    await this.tx(async (tx) => {
      await tx.query(
        "UPDATE flow_instances SET state=$3,wait_reason=$4,updated_at=clock_timestamp(),revision=revision+1 WHERE tenant_id=$1 AND id=$2",
        [tenantId, flowId, state, waitReason ?? null],
      );
    });
  }
  async getProfile(
    tenantId: string,
    profileId: string,
  ): Promise<ProfileRecord> {
    return this.tx(async (tx) => {
      const p = await one(
        tx,
        "SELECT * FROM logical_profiles WHERE tenant_id=$1 AND id=$2",
        [tenantId, profileId],
      );
      if (!p) return error("Profile not found", "profile_not_found", 404);
      const s = p.published_snapshot_id
        ? await one(
            tx,
            "SELECT * FROM profile_snapshots WHERE tenant_id=$1 AND id=$2",
            [tenantId, p.published_snapshot_id],
          )
        : undefined;
      return {
        id: p.id,
        tenantId: p.tenant_id,
        kameleoProfileId: p.kameleo_profile_id ?? undefined,
        state: p.state,
        revision: number(p.revision),
        leaseEpoch: number(p.lease_epoch),
        snapshotGeneration: number(p.snapshot_generation),
        metadata: p.metadata,
        ...(s ? { snapshot: this.snapshotRecord(s) } : {}),
      };
    });
  }
  private async grant(
    tx: SqlExecutor,
    tenantId: string,
    id: string,
  ): Promise<LeaseGrant> {
    const r = await one(
      tx,
      "SELECT l.*,p.kameleo_profile_id FROM browser_leases l JOIN logical_profiles p ON p.tenant_id=l.tenant_id AND p.id=l.profile_id WHERE l.tenant_id=$1 AND l.id=$2",
      [tenantId, id],
    );
    if (!r) return error("Lease not found", "lease_not_found", 404);
    return {
      id: r.id,
      tenantId: r.tenant_id,
      flowId: r.flow_id,
      attachmentId: r.attachment_id,
      profileId: r.profile_id,
      quotaDomainId: r.quota_domain_id,
      nodeId: r.node_id,
      nodeIncarnationId: r.node_incarnation_id,
      epoch: number(r.lease_epoch),
      expiresAt: iso(r.authorization_expires_at),
      state: r.state,
      capacityReleased: !!r.capacity_released_at,
      released: !!r.released_at,
      ...(r.identity_id
        ? { identityId: r.identity_id, bindingId: r.binding_id }
        : {}),
      ...(r.kameleo_profile_id
        ? { kameleoProfileId: r.kameleo_profile_id }
        : {}),
    };
  }
  async leaseForFlow(
    tenantId: string,
    flowId: string,
  ): Promise<LeaseGrant | null> {
    return this.tx(async (tx) => {
      const r = await one(
        tx,
        "SELECT id FROM browser_leases WHERE tenant_id=$1 AND flow_id=$2 ORDER BY acquired_at DESC LIMIT 1",
        [tenantId, flowId],
      );
      return r ? this.grant(tx, tenantId, r.id) : null;
    });
  }
  async listNodeLeases(
    tenantId: string,
    nodeId: string,
  ): Promise<LeaseGrant[]> {
    return this.tx(async (tx) => {
      const rows = await tx.query<Row>(
        "SELECT id FROM browser_leases WHERE tenant_id=$1 AND node_id=$2 AND released_at IS NULL",
        [tenantId, nodeId],
      );
      const grants: LeaseGrant[] = [];
      for (const r of rows.rows)
        grants.push(await this.grant(tx, tenantId, r.id));
      return grants;
    });
  }
  private async lockedLease(
    tx: SqlExecutor,
    g: LeaseGrant,
    requireLive = false,
  ): Promise<Row> {
    const r = await one(
      tx,
      `SELECT l.*,l.authorization_expires_at>clock_timestamp() AS valid,p.lease_epoch AS current_epoch,p.tombstoned_at,
      n.agent_epoch AS current_agent_epoch,i.agent_epoch AS owner_agent_epoch,i.fenced_at
      FROM browser_leases l JOIN logical_profiles p ON p.tenant_id=l.tenant_id AND p.id=l.profile_id
      JOIN engine_nodes n ON n.tenant_id=l.tenant_id AND n.id=l.node_id JOIN node_incarnations i ON i.tenant_id=l.tenant_id AND i.id=l.node_incarnation_id
      WHERE l.tenant_id=$1 AND l.id=$2 FOR UPDATE OF l`,
      [g.tenantId, g.id],
    );
    if (
      !r ||
      r.profile_id !== g.profileId ||
      r.flow_id !== g.flowId ||
      r.node_incarnation_id !== g.nodeIncarnationId ||
      number(r.lease_epoch) !== g.epoch
    )
      return error("Lease fence does not match", "stale_lease");
    if (r.released_at) return error("Lease is released", "lease_released");
    if (
      requireLive &&
      (!r.valid ||
        r.state !== "held" ||
        r.capacity_released_at ||
        r.tombstoned_at ||
        number(r.current_epoch) !== g.epoch ||
        number(r.current_agent_epoch) !== number(r.owner_agent_epoch) ||
        r.fenced_at)
    )
      return error(
        "Lease no longer authorizes browser actions",
        "lease_expired",
      );
    return r;
  }
  async acquire(request: {
    tenantId: string;
    flowId: string;
    ttlMs?: number;
  }): Promise<LeaseGrant | null> {
    const ttl = request.ttlMs ?? 45_000;
    if (ttl < 100 || ttl > 300_000)
      error("Lease TTL outside allowed range", "invalid_ttl", 400);
    return this.tx(async (tx) => {
      const f = await this.flow(tx, request.tenantId, request.flowId);
      const d = await one(
        tx,
        "SELECT *,starts_blocked_until>clock_timestamp() AS cooling FROM quota_domains WHERE id=$1 FOR UPDATE",
        [f.quotaDomainId],
      );
      const existing = await one(
        tx,
        "SELECT id FROM browser_leases WHERE tenant_id=$1 AND flow_id=$2 AND released_at IS NULL",
        [f.tenantId, f.id],
      );
      if (existing) return this.grant(tx, f.tenantId, existing.id);
      const wait = async (reason: string) => {
        await tx.query(
          "UPDATE flow_instances SET wait_reason=$3,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",
          [f.tenantId, f.id, reason],
        );
        return null;
      };
      if (f.state !== "queued") return wait("not_queued");
      if (new Date(f.deadlineAt).getTime() <= Date.now()) {
        await tx.query(
          "UPDATE flow_instances SET state='failed',wait_reason='deadline_expired' WHERE tenant_id=$1 AND id=$2",
          [f.tenantId, f.id],
        );
        return null;
      }
      if (!d || d.admission_state !== "open" || d.cooling)
        return wait("waiting_provider_capacity");
      if (f.identityId) {
        const i = await one(
          tx,
          "SELECT * FROM identities WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
          [f.tenantId, f.identityId],
        );
        if (!i || i.tombstoned_at || i.state !== "ready")
          return wait("identity_unavailable");
      }
      const p = await one(
        tx,
        "SELECT * FROM logical_profiles WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [f.tenantId, f.profileId],
      );
      if (
        !p ||
        p.tombstoned_at ||
        p.state === "quarantined" ||
        p.state === "retired"
      )
        return wait("profile_unavailable");
      const binding = await one(
        tx,
        "SELECT * FROM identity_bindings WHERE tenant_id=$1 AND profile_id=$2 AND retired_at IS NULL",
        [f.tenantId, f.profileId],
      );
      if ((binding?.identity_id ?? undefined) !== f.identityId)
        return wait("binding_changed");
      const node = await one(
        tx,
        "SELECT * FROM engine_nodes WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [f.tenantId, f.nodeId],
      );
      if (node?.state !== "ready") return wait("waiting_node");
      const inc = await one(
        tx,
        "SELECT * FROM node_incarnations WHERE tenant_id=$1 AND node_id=$2 AND agent_epoch=$3 AND fenced_at IS NULL",
        [f.tenantId, f.nodeId, node.agent_epoch],
      );
      if (!inc) return wait("waiting_node");
      if (
        await one(
          tx,
          "SELECT 1 FROM browser_leases WHERE tenant_id=$1 AND released_at IS NULL AND (profile_id=$2 OR identity_id=$3) LIMIT 1",
          [f.tenantId, f.profileId, f.identityId ?? null],
        )
      )
        return wait("waiting_profile");
      const assignment = await one(
        tx,
        "SELECT mobile FROM flow_assignments WHERE tenant_id=$1 AND flow_id=$2",
        [f.tenantId, f.id],
      );
      const counts = await one(
        tx,
        "SELECT count(*) AS total,count(*) FILTER(WHERE mobile) AS mobile FROM browser_leases WHERE quota_domain_id=$1 AND capacity_released_at IS NULL",
        [f.quotaDomainId],
      );
      if (
        number(counts!.total) >= d.total_browser_budget ||
        (assignment!.mobile &&
          number(counts!.mobile) >= d.mobile_browser_budget)
      )
        return wait("waiting_provider_capacity");
      const nc = await one(
        tx,
        "SELECT count(*) AS count FROM browser_leases WHERE tenant_id=$1 AND node_id=$2 AND capacity_released_at IS NULL",
        [f.tenantId, f.nodeId],
      );
      if (number(nc!.count) >= node.max_browsers) return wait("waiting_node");
      const head = await one(
        tx,
        `SELECT q.tenant_id,q.id FROM flow_instances q JOIN flow_assignments a ON a.tenant_id=q.tenant_id AND a.flow_id=q.id
        JOIN quota_tenant_fairness fair ON fair.tenant_id=q.tenant_id AND fair.quota_domain_id=a.quota_domain_id JOIN tenants t ON t.id=q.tenant_id
        JOIN engine_nodes n ON n.tenant_id=q.tenant_id AND n.id=a.node_id
        JOIN flow_session_attachments s ON s.tenant_id=q.tenant_id AND s.flow_id=q.id AND s.closed_at IS NULL
        JOIN logical_profiles lp ON lp.tenant_id=q.tenant_id AND lp.id=s.profile_id
        LEFT JOIN identities identity_row ON identity_row.tenant_id=q.tenant_id AND identity_row.id=s.identity_id
        WHERE a.quota_domain_id=$1 AND q.state='queued' AND q.absolute_deadline_at>clock_timestamp() AND n.state='ready'
        AND lp.tombstoned_at IS NULL AND lp.state NOT IN('retired','quarantined')
        AND(s.identity_id IS NULL OR(identity_row.tombstoned_at IS NULL AND identity_row.state='ready'))
        AND EXISTS(SELECT 1 FROM profile_replicas r WHERE r.tenant_id=q.tenant_id AND r.profile_id=s.profile_id AND r.node_id=a.node_id AND r.role='authoritative' AND r.retired_at IS NULL)
        AND((s.identity_id IS NULL AND NOT EXISTS(SELECT 1 FROM identity_bindings b WHERE b.tenant_id=q.tenant_id AND b.profile_id=s.profile_id AND b.retired_at IS NULL))
          OR EXISTS(SELECT 1 FROM identity_bindings b WHERE b.tenant_id=q.tenant_id AND b.id=s.binding_id AND b.identity_id=s.identity_id AND b.profile_id=s.profile_id AND b.retired_at IS NULL))
        AND NOT EXISTS(SELECT 1 FROM browser_leases l WHERE l.tenant_id=q.tenant_id AND l.released_at IS NULL AND(l.profile_id=s.profile_id OR l.identity_id=s.identity_id))
        AND (SELECT count(*) FROM browser_leases l WHERE l.tenant_id=q.tenant_id AND l.node_id=a.node_id AND l.capacity_released_at IS NULL)<n.max_browsers
        AND (NOT a.mobile OR $2::bigint<$3::bigint)
        ORDER BY fair.virtual_finish, q.queue_priority DESC,q.queued_at,q.id LIMIT 1`,
        [f.quotaDomainId, number(counts!.mobile), d.mobile_browser_budget],
      );
      if (head && (head.id !== f.id || head.tenant_id !== f.tenantId))
        return wait("waiting_tenant_turn");
      const replica = await one(
        tx,
        "SELECT id FROM profile_replicas WHERE tenant_id=$1 AND profile_id=$2 AND node_id=$3 AND role='authoritative' AND retired_at IS NULL",
        [f.tenantId, f.profileId, f.nodeId],
      );
      if (!replica) return wait("migration_required");
      const epoch = await one(
        tx,
        "UPDATE logical_profiles SET lease_epoch=lease_epoch+1 WHERE tenant_id=$1 AND id=$2 RETURNING lease_epoch",
        [f.tenantId, f.profileId],
      );
      const leaseId = randomUUID();
      await tx.query(
        `INSERT INTO browser_leases(tenant_id,id,flow_id,attachment_id,identity_id,binding_id,profile_id,replica_id,quota_domain_id,node_id,node_incarnation_id,lease_epoch,mobile,authorization_expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,clock_timestamp()+$14*interval '1 millisecond')`,
        [
          f.tenantId,
          leaseId,
          f.id,
          f.attachmentId,
          f.identityId ?? null,
          f.bindingId ?? null,
          f.profileId,
          replica.id,
          f.quotaDomainId,
          f.nodeId,
          inc.id,
          epoch!.lease_epoch,
          assignment!.mobile,
          ttl,
        ],
      );
      await tx.query(
        "UPDATE flow_instances SET state='preparing',wait_reason=NULL,owner_epoch=owner_epoch+1,owner_id=$3,owner_expires_at=clock_timestamp()+$4*interval '1 millisecond',updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",
        [f.tenantId, f.id, inc.id, ttl],
      );
      await tx.query(
        "UPDATE quota_tenant_fairness SET virtual_finish=virtual_finish+1/(SELECT scheduling_weight FROM tenants WHERE id=$2) WHERE quota_domain_id=$1 AND tenant_id=$2",
        [f.quotaDomainId, f.tenantId],
      );
      return this.grant(tx, f.tenantId, leaseId);
    });
  }
  async renew(g: LeaseGrant, ttlMs = 45_000): Promise<LeaseGrant> {
    if (ttlMs < 100 || ttlMs > 300_000)
      error("Invalid lease duration", "invalid_ttl", 400);
    return this.tx(async (tx) => {
      await this.lockedLease(tx, g, true);
      await tx.query(
        "UPDATE browser_leases SET heartbeat_at=clock_timestamp(),authorization_expires_at=clock_timestamp()+$3*interval '1 millisecond' WHERE tenant_id=$1 AND id=$2",
        [g.tenantId, g.id, ttlMs],
      );
      await tx.query(
        "UPDATE flow_instances SET owner_expires_at=clock_timestamp()+$3*interval '1 millisecond' WHERE tenant_id=$1 AND id=$2",
        [g.tenantId, g.flowId, ttlMs],
      );
      await tx.query(
        "UPDATE node_incarnations SET heartbeat_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",
        [g.tenantId, g.nodeIncarnationId],
      );
      return this.grant(tx, g.tenantId, g.id);
    });
  }
  async expireLeases(limit = 100): Promise<LeaseGrant[]> {
    return this.tx(async (tx) => {
      const rows = await tx.query<Row>(
        `UPDATE browser_leases SET state='quarantined' WHERE (tenant_id,id) IN(SELECT tenant_id,id FROM browser_leases WHERE state='held' AND authorization_expires_at<=clock_timestamp() AND released_at IS NULL FOR UPDATE SKIP LOCKED LIMIT $1) RETURNING tenant_id,id`,
        [Math.max(1, Math.min(limit, 1000))],
      );
      const grants: LeaseGrant[] = [];
      for (const r of rows.rows)
        grants.push(await this.grant(tx, r.tenant_id, r.id));
      return grants;
    });
  }
  async quarantine(g: LeaseGrant, reason = "reconciling"): Promise<void> {
    await this.tx(async (tx) => {
      await this.lockedLease(tx, g);
      await tx.query(
        "UPDATE browser_leases SET state='quarantined' WHERE tenant_id=$1 AND id=$2",
        [g.tenantId, g.id],
      );
      await tx.query(
        "UPDATE flow_instances SET state='recovering',wait_reason=$3 WHERE tenant_id=$1 AND id=$2",
        [g.tenantId, g.flowId, reason],
      );
    });
  }
  private operation(r: Row): LifecycleOperation {
    return {
      id: r.id,
      leaseId: r.lease_id,
      sequence: number(r.sequence),
      kind: r.kind,
      state: r.state,
      deadlineAt: iso(r.deadline_at),
      recoveryTag: r.recovery_tag ?? undefined,
      resolvedAt: r.resolved_at ? iso(r.resolved_at) : undefined,
      vendorErrorCode: r.vendor_error_code ?? undefined,
    };
  }
  async beginOperation(
    g: LeaseGrant,
    input: {
      kind: OperationKind;
      requestDigest: string;
      deadlineAt: string;
      recoveryTag?: string;
      operationId?: string;
    },
  ): Promise<LifecycleOperation> {
    return this.tx(async (tx) => {
      const lease = await this.lockedLease(
        tx,
        g,
        !["stop", "export"].includes(input.kind),
      );
      if (input.kind === "export" && !lease.stop_barrier_id)
        error("Export requires confirmed quiescence", "stop_not_confirmed");
      const operationId = input.operationId ?? randomUUID();
      const old = await one(
        tx,
        "SELECT * FROM lifecycle_operations WHERE tenant_id=$1 AND id=$2",
        [g.tenantId, operationId],
      );
      if (old) {
        if (
          old.lease_id !== g.id ||
          old.kind !== input.kind ||
          Buffer.from(old.request_digest).toString("hex") !==
            input.requestDigest.toLowerCase()
        )
          error("Operation ID collision", "operation_conflict");
        return this.operation(old);
      }
      if (
        await one(
          tx,
          "SELECT 1 FROM lifecycle_operations WHERE tenant_id=$1 AND lease_id=$2 AND resolved_at IS NULL",
          [g.tenantId, g.id],
        )
      )
        error(
          "Earlier lifecycle operation remains unresolved",
          "operation_pending",
        );
      const p = await one(
        tx,
        "SELECT revision FROM logical_profiles WHERE tenant_id=$1 AND id=$2",
        [g.tenantId, g.profileId],
      );
      const sequence = number(
        (await one(
          tx,
          "SELECT coalesce(max(sequence),0)+1 AS n FROM lifecycle_operations WHERE tenant_id=$1 AND lease_id=$2",
          [g.tenantId, g.id],
        ))!.n,
      );
      const op = await one(
        tx,
        `INSERT INTO lifecycle_operations(tenant_id,id,lease_id,node_incarnation_id,sequence,operation_key,kind,request_digest,recovery_tag,expected_profile_revision,deadline_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [
          g.tenantId,
          operationId,
          g.id,
          g.nodeIncarnationId,
          sequence,
          operationId,
          input.kind,
          digest(input.requestDigest),
          input.recoveryTag ?? null,
          p!.revision,
          input.deadlineAt,
        ],
      );
      await tx.query(
        "INSERT INTO agent_outbox(tenant_id,operation_id) VALUES($1,$2)",
        [g.tenantId, operationId],
      );
      return this.operation(op!);
    });
  }
  async markDispatched(g: LeaseGrant, operationId: string): Promise<void> {
    await this.tx(async (tx) => {
      await this.lockedLease(tx, g);
      const op = await one(
        tx,
        "SELECT * FROM lifecycle_operations WHERE tenant_id=$1 AND id=$2 AND lease_id=$3 FOR UPDATE",
        [g.tenantId, operationId, g.id],
      );
      if (!op) error("Operation not found", "operation_not_found", 404);
      if (op!.state !== "prepared")
        error("Operation cannot be dispatched again", "operation_not_prepared");
      if (!["stop", "export"].includes(op!.kind))
        await this.lockedLease(tx, g, true);
      await tx.query(
        "UPDATE lifecycle_operations SET state='dispatched',dispatched_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",
        [g.tenantId, operationId],
      );
      await tx.query(
        "UPDATE agent_outbox SET accepted_by_agent_at=clock_timestamp(),delivery_attempts=delivery_attempts+1 WHERE tenant_id=$1 AND operation_id=$2",
        [g.tenantId, operationId],
      );
    });
  }
  async resolveOperation(
    g: LeaseGrant,
    operationId: string,
    input: {
      state?:
        | "succeeded"
        | "rejected"
        | "reconciled"
        | "cancelled_before_dispatch";
      outcome?:
        | "succeeded"
        | "rejected"
        | "reconciled"
        | "cancelled_before_dispatch";
      errorCode?: string;
      vendorErrorCode?: string;
      evidenceDigest?: string;
    },
  ): Promise<void> {
    const result = {
      ...input,
      state: input.state ?? input.outcome,
      errorCode: input.errorCode ?? input.vendorErrorCode,
    };
    if (!result.state)
      error("Operation outcome is required", "invalid_outcome", 400);
    await this.tx(async (tx) => {
      await this.lockedLease(tx, g);
      const op = await one(
        tx,
        "SELECT * FROM lifecycle_operations WHERE tenant_id=$1 AND id=$2 AND lease_id=$3 FOR UPDATE",
        [g.tenantId, operationId, g.id],
      );
      if (!op) error("Operation not found", "operation_not_found", 404);
      if (op!.resolved_at) {
        if (op!.state !== result.state)
          error(
            "Resolved operation cannot change outcome",
            "operation_resolved",
          );
        return;
      }
      if (
        result.state === "cancelled_before_dispatch" &&
        op!.state !== "prepared"
      )
        error(
          "Dispatched work cannot be declared undispatched",
          "uncertain_operation",
        );
      if (result.state === "reconciled" && !result.evidenceDigest)
        error("Reconciliation needs agent evidence", "evidence_required");
      await tx.query(
        "UPDATE lifecycle_operations SET state=$3,resolved_at=clock_timestamp(),vendor_error_code=$4,resolution_evidence_digest=$5 WHERE tenant_id=$1 AND id=$2",
        [
          g.tenantId,
          operationId,
          result.state,
          result.errorCode ?? null,
          result.evidenceDigest ? digest(result.evidenceDigest) : null,
        ],
      );
    });
  }
  async markOperationUnknown(
    g: LeaseGrant,
    operationId: string,
  ): Promise<void> {
    await this.tx(async (tx) => {
      await this.lockedLease(tx, g);
      await tx.query(
        "UPDATE lifecycle_operations SET state='unknown' WHERE tenant_id=$1 AND id=$2 AND lease_id=$3 AND resolved_at IS NULL",
        [g.tenantId, operationId, g.id],
      );
      await tx.query(
        "UPDATE browser_leases SET state='quarantined' WHERE tenant_id=$1 AND id=$2",
        [g.tenantId, g.id],
      );
      await tx.query(
        "UPDATE flow_instances SET state='recovering',wait_reason='uncertain_lifecycle' WHERE tenant_id=$1 AND id=$2",
        [g.tenantId, g.flowId],
      );
    });
  }
  async listPendingOperations(
    scope: string | LeaseGrant,
    filter: { nodeId?: string; leaseId?: string } = {},
  ): Promise<LifecycleOperation[]> {
    const tenantId = typeof scope === "string" ? scope : scope.tenantId;
    if (typeof scope !== "string") filter = { leaseId: scope.id };
    return this.tx(async (tx) =>
      (
        await tx.query<Row>(
          `SELECT o.* FROM lifecycle_operations o JOIN browser_leases l ON l.tenant_id=o.tenant_id AND l.id=o.lease_id
    WHERE o.tenant_id=$1 AND o.resolved_at IS NULL AND ($2::uuid IS NULL OR l.node_id=$2) AND ($3::uuid IS NULL OR l.id=$3) ORDER BY o.created_at`,
          [tenantId, filter.nodeId ?? null, filter.leaseId ?? null],
        )
      ).rows.map((r) => this.operation(r)),
    );
  }
  async listOperations(g: LeaseGrant): Promise<LifecycleOperation[]> {
    return this.tx(async (tx) =>
      (
        await tx.query<Row>(
          "SELECT * FROM lifecycle_operations WHERE tenant_id=$1 AND lease_id=$2 ORDER BY sequence",
          [g.tenantId, g.id],
        )
      ).rows.map((r) => this.operation(r)),
    );
  }
  async recordProfileCreated(
    g: LeaseGrant,
    vendorProfileId: string,
  ): Promise<void> {
    await this.tx(async (tx) => {
      await this.lockedLease(tx, g);
      const p = await one(
        tx,
        "SELECT * FROM logical_profiles WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [g.tenantId, g.profileId],
      );
      if (p!.kameleo_profile_id && p!.kameleo_profile_id !== vendorProfileId)
        error(
          "Profile already has another vendor identity",
          "profile_conflict",
        );
      await tx.query(
        "UPDATE logical_profiles SET kameleo_profile_id=$3,state='ready',revision=revision+1 WHERE tenant_id=$1 AND id=$2 AND kameleo_profile_id IS NULL",
        [g.tenantId, g.profileId, vendorProfileId],
      );
    });
  }
  async setProfileMetadata(g: LeaseGrant, patch: JsonObject): Promise<void> {
    await this.tx(async (tx) => {
      await this.lockedLease(tx, g, true);
      await tx.query(
        "UPDATE logical_profiles SET metadata=metadata||$3::jsonb WHERE tenant_id=$1 AND id=$2",
        [g.tenantId, g.profileId, json(patch)],
      );
    });
  }
  async reserveRequest(
    g: LeaseGrant,
    endpoint: "SearchFingerprints" | "CreateProfile" | "StartProfile",
    operationId?: string,
  ): Promise<{ id: string; notBefore: string; dispatchBefore: string }> {
    return this.tx(async (tx) => {
      const d = await one(
        tx,
        "SELECT * FROM quota_domains WHERE id=$1 FOR UPDATE",
        [g.quotaDomainId],
      );
      await this.lockedLease(tx, g, true);
      const row = await one(
        tx,
        `UPDATE quota_domains SET next_counted_request_at=greatest(clock_timestamp(),next_counted_request_at)+($2::double precision)*interval '1 millisecond' WHERE id=$1 RETURNING next_counted_request_at-($2::double precision)*interval '1 millisecond' AS start`,
        [g.quotaDomainId, Math.ceil(63_000 / d!.counted_requests_per_minute)],
      );
      const id = randomUUID(),
        start = iso(row!.start);
      const end = new Date(new Date(start).getTime() + 500).toISOString();
      await tx.query(
        "INSERT INTO counted_request_reservations(id,quota_domain_id,tenant_id,operation_id,endpoint,not_before,dispatch_before) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          id,
          g.quotaDomainId,
          g.tenantId,
          operationId ?? null,
          endpoint,
          start,
          end,
        ],
      );
      return { id, notBefore: start, dispatchBefore: end };
    });
  }
  async markRequestDispatched(
    g: LeaseGrant,
    reservationId: string,
  ): Promise<void> {
    await this.tx(async (tx) => {
      await this.lockedLease(tx, g, true);
      const r = await one(
        tx,
        "UPDATE counted_request_reservations SET dispatched_at=clock_timestamp() WHERE id=$1 AND tenant_id=$2 AND quota_domain_id=$3 AND dispatched_at IS NULL AND clock_timestamp()>=not_before AND clock_timestamp()<dispatch_before RETURNING id",
        [reservationId, g.tenantId, g.quotaDomainId],
      );
      if (!r)
        error(
          "Rate reservation expired or already dispatched",
          "rate_reservation_invalid",
        );
    });
  }
  async providerBackoff(quotaDomainId: string, delayMs: number): Promise<void> {
    await this.tx(async (tx) => {
      await tx.query(
        "UPDATE quota_domains SET starts_blocked_until=greatest(starts_blocked_until,clock_timestamp()+$2*interval '1 millisecond') WHERE id=$1",
        [quotaDomainId, Math.max(0, Math.min(delayMs, 300_000))],
      );
    });
  }
  async confirmStopped(g: LeaseGrant, proof: StopProof): Promise<LeaseGrant> {
    return this.tx(async (tx) => {
      await tx.query("SELECT id FROM quota_domains WHERE id=$1 FOR UPDATE", [
        g.quotaDomainId,
      ]);
      const lease = await this.lockedLease(tx, g);
      if (lease.capacity_released_at) return this.grant(tx, g.tenantId, g.id);
      const ops = (
        await tx.query<Row>(
          "SELECT * FROM lifecycle_operations WHERE tenant_id=$1 AND lease_id=$2 ORDER BY sequence",
          [g.tenantId, g.id],
        )
      ).rows;
      const maximum = Math.max(0, ...ops.map((o) => number(o.sequence)));
      if (proof.coversLifecycleSequence < maximum)
        error(
          "Stop proof does not cover the latest lifecycle operation",
          "barrier_incomplete",
        );
      if (
        proof.kind === "never_dispatched" &&
        ops.some(
          (o) =>
            o.dispatched_at ||
            !["prepared", "cancelled_before_dispatch"].includes(o.state),
        )
      )
        error(
          "A lifecycle request may have reached Engine",
          "request_was_dispatched",
        );
      if (
        proof.kind === "no_browser_started" &&
        ops.some(
          (o) =>
            !o.resolved_at ||
            !["rejected", "cancelled_before_dispatch"].includes(o.state),
        )
      )
        error(
          "Only definite rejections or undispatched cancellations establish this barrier",
          "browser_may_have_started",
        );
      if (proof.kind === "drained_and_stopped") {
        if (ops.some((o) => !o.resolved_at))
          error(
            "A delayed lifecycle request may still complete",
            "operation_pending",
          );
        const stop = Math.max(
          0,
          ...ops
            .filter((o) => o.kind === "stop" && o.state === "succeeded")
            .map((o) => number(o.sequence)),
        );
        const mayStart = Math.max(
          0,
          ...ops
            .filter(
              (o) =>
                ["start", "attach"].includes(o.kind) &&
                !["rejected", "cancelled_before_dispatch"].includes(o.state),
            )
            .map((o) => number(o.sequence)),
        );
        if (!stop || stop < mayStart)
          error(
            "Stop acknowledgement must follow every possible start",
            "stop_not_confirmed",
          );
      }
      const evidence = digest(proof.evidenceDigest),
        observationId = randomUUID(),
        barrierId = randomUUID();
      await tx.query(
        `INSERT INTO agent_observations(tenant_id,id,lease_id,node_incarnation_id,local_sequence,observation_kind,evidence_digest,observed_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp())`,
        [
          g.tenantId,
          observationId,
          g.id,
          g.nodeIncarnationId,
          proof.localSequence,
          proof.kind,
          evidence,
        ],
      );
      if (proof.kind !== "drained_and_stopped")
        await tx.query(
          `UPDATE lifecycle_operations SET state=$3,resolved_at=clock_timestamp(),resolution_evidence_digest=$4 WHERE tenant_id=$1 AND lease_id=$2 AND resolved_at IS NULL`,
          [
            g.tenantId,
            g.id,
            proof.kind === "never_dispatched"
              ? "cancelled_before_dispatch"
              : "reconciled",
            evidence,
          ],
        );
      if (proof.kind === "isolation_fenced") {
        await tx.query(
          "UPDATE node_incarnations SET fenced_at=clock_timestamp(),fence_evidence_digest=$3 WHERE tenant_id=$1 AND id=$2",
          [g.tenantId, g.nodeIncarnationId, evidence],
        );
        await tx.query(
          "UPDATE engine_nodes SET state='recovering' WHERE tenant_id=$1 AND id=$2",
          [g.tenantId, g.nodeId],
        );
        await tx.query(
          "UPDATE browser_leases SET state='quarantined' WHERE tenant_id=$1 AND node_id=$2 AND released_at IS NULL",
          [g.tenantId, g.nodeId],
        );
      }
      await tx.query(
        "INSERT INTO stop_barriers(tenant_id,id,lease_id,observation_id,kind,covers_lifecycle_sequence,established_at) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp())",
        [
          g.tenantId,
          barrierId,
          g.id,
          observationId,
          proof.kind,
          proof.coversLifecycleSequence,
        ],
      );
      await tx.query(
        "UPDATE browser_leases SET stop_barrier_id=$3,capacity_released_at=clock_timestamp(),state='releasing' WHERE tenant_id=$1 AND id=$2",
        [g.tenantId, g.id, barrierId],
      );
      return this.grant(tx, g.tenantId, g.id);
    });
  }
  async release(
    g: LeaseGrant,
    options: { disposition: "saved" | "preserved" },
  ): Promise<void> {
    await this.tx(async (tx) => {
      await tx.query("SELECT id FROM quota_domains WHERE id=$1 FOR UPDATE", [
        g.quotaDomainId,
      ]);
      const current = await this.grant(tx, g.tenantId, g.id);
      if (current.released) return;
      const lease = await this.lockedLease(tx, g);
      if (!lease.capacity_released_at || !lease.stop_barrier_id)
        error("Stop proof is required before release", "stop_not_confirmed");
      if (
        await one(
          tx,
          "SELECT 1 FROM lifecycle_operations WHERE tenant_id=$1 AND lease_id=$2 AND resolved_at IS NULL",
          [g.tenantId, g.id],
        )
      )
        error("Lifecycle outcome is unresolved", "operation_pending");
      if (
        await one(
          tx,
          "SELECT 1 FROM action_journal WHERE tenant_id=$1 AND flow_id=$2 AND resolved_at IS NULL",
          [g.tenantId, g.flowId],
        )
      )
        error("Site effect needs reconciliation", "action_pending");
      if (
        await one(
          tx,
          "SELECT 1 FROM flow_runtime_data WHERE tenant_id=$1 AND flow_id=$2 AND checkpoint->'pending'->>'phase' IN('dispatched','uncertain')",
          [g.tenantId, g.flowId],
        )
      )
        error("Interpreter effect needs reconciliation", "action_pending");
      if (
        options.disposition === "saved" &&
        !(await one(
          tx,
          "SELECT 1 FROM profile_snapshots WHERE tenant_id=$1 AND lease_id=$2 AND state='published'",
          [g.tenantId, g.id],
        ))
      )
        error(
          "No verified published snapshot for this lease",
          "snapshot_missing",
        );
      await tx.query(
        "UPDATE browser_leases SET state='released',released_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",
        [g.tenantId, g.id],
      );
      await tx.query(
        "UPDATE flow_session_attachments SET closed_at=clock_timestamp(),closure_reason=$3 WHERE tenant_id=$1 AND id=$2",
        [g.tenantId, g.attachmentId, options.disposition],
      );
    });
  }
  private bindingResult(r: Row): BindingResult {
    return {
      operationId: r.id,
      state: r.state,
      identityId: r.identity_id,
      bindingId: r.result_binding_id,
      profileId: r.result_profile_id,
    };
  }
  /** Receipt cryptographic verification belongs at the owned-site trust boundary. */
  async bindIdentity(
    g: LeaseGrant,
    receipt: VerifiedIdentity,
  ): Promise<BindingResult> {
    return this.tx(async (tx) => {
      const f = await this.flow(tx, g.tenantId, g.flowId);
      const prior = await one(
        tx,
        `SELECT b.*,r.assertion_digest,r.flow_id AS receipt_flow FROM verified_identity_receipts r JOIN binding_operations b ON b.tenant_id=r.tenant_id AND b.receipt_id=r.id
      WHERE r.tenant_id=$1 AND r.site_id=$2 AND r.subject_issuer=$3 AND r.nonce_digest=$4`,
        [g.tenantId, f.siteId, receipt.issuer, digest(receipt.nonceDigest)],
      );
      if (prior) {
        if (
          prior.receipt_flow !== g.flowId ||
          Buffer.from(prior.assertion_digest).toString("hex") !==
            receipt.assertionDigest.toLowerCase()
        )
          error(
            "Identity receipt was already consumed by another request",
            "receipt_replay",
          );
        return this.bindingResult(prior);
      }
      const site = await one(
        tx,
        "SELECT * FROM owned_sites WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [g.tenantId, f.siteId],
      );
      if (number(site!.active_identity_key_version) !== receipt.hmacKeyVersion)
        error("Identity key version is not active", "identity_key_version");
      if (
        !receipt.subjectKey ||
        !receipt.issuer ||
        new Date(receipt.expiresAt).getTime() <= Date.now() ||
        new Date(receipt.verifiedAt).getTime() > Date.now() + 5_000
      )
        error(
          "Identity verification is expired or invalid",
          "invalid_receipt",
          400,
        );
      let alias = await one(
        tx,
        "SELECT identity_id FROM identity_subject_aliases WHERE tenant_id=$1 AND site_id=$2 AND subject_issuer=$3 AND hmac_key_version=$4 AND subject_key=$5",
        [
          g.tenantId,
          f.siteId,
          receipt.issuer,
          receipt.hmacKeyVersion,
          receipt.subjectKey,
        ],
      );
      if (!alias) {
        const created = await one(
          tx,
          `INSERT INTO identities(tenant_id,id,site_id,subject_issuer,subject_key,hmac_key_version,last_authorized_use_at)
        VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()) ON CONFLICT(tenant_id,site_id,subject_issuer,hmac_key_version,subject_key) DO UPDATE SET subject_key=EXCLUDED.subject_key RETURNING id`,
          [
            g.tenantId,
            randomUUID(),
            f.siteId,
            receipt.issuer,
            receipt.subjectKey,
            receipt.hmacKeyVersion,
          ],
        );
        await tx.query(
          "INSERT INTO identity_subject_aliases VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
          [
            g.tenantId,
            f.siteId,
            receipt.issuer,
            receipt.hmacKeyVersion,
            receipt.subjectKey,
            created!.id,
          ],
        );
        alias = { identity_id: created!.id };
      }
      const identity = await one(
        tx,
        "SELECT * FROM identities WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [g.tenantId, alias.identity_id],
      );
      if (identity!.tombstoned_at || identity!.state !== "ready")
        error("Identity is quarantined or retired", "identity_unavailable");
      const p = await one(
        tx,
        "SELECT * FROM logical_profiles WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [g.tenantId, g.profileId],
      );
      if (p!.tombstoned_at)
        error("Candidate profile is retired", "profile_unavailable");
      await this.lockedLease(tx, g, true);
      const existingProfileBinding = await one(
        tx,
        "SELECT * FROM identity_bindings WHERE tenant_id=$1 AND profile_id=$2 AND retired_at IS NULL",
        [g.tenantId, g.profileId],
      );
      if (
        existingProfileBinding &&
        existingProfileBinding.identity_id !== identity!.id
      )
        error(
          "Profile belongs to a different verified identity",
          "profile_identity_conflict",
        );
      let binding = await one(
        tx,
        "SELECT * FROM identity_bindings WHERE tenant_id=$1 AND identity_id=$2 AND retired_at IS NULL",
        [g.tenantId, identity!.id],
      );
      if (!binding) {
        const revision = number(
          (await one(
            tx,
            "SELECT coalesce(max(binding_revision),0)+1 AS n FROM identity_bindings WHERE tenant_id=$1 AND identity_id=$2",
            [g.tenantId, identity!.id],
          ))!.n,
        );
        binding = await one(
          tx,
          "INSERT INTO identity_bindings(tenant_id,id,identity_id,profile_id,binding_revision,verified_subject_at) VALUES($1,$2,$3,$4,$5,clock_timestamp()) RETURNING *",
          [g.tenantId, randomUUID(), identity!.id, g.profileId, revision],
        );
      }
      const adopted = binding!.profile_id === g.profileId;
      if (adopted) {
        await tx.query(
          "UPDATE flow_session_attachments SET identity_id=$3,binding_id=$4,bound_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND closed_at IS NULL",
          [g.tenantId, g.attachmentId, identity!.id, binding!.id],
        );
        await tx.query(
          "UPDATE browser_leases SET identity_id=$3,binding_id=$4 WHERE tenant_id=$1 AND id=$2",
          [g.tenantId, g.id, identity!.id, binding!.id],
        );
      } else
        await tx.query(
          "UPDATE flow_instances SET state='review',wait_reason='switch_pending' WHERE tenant_id=$1 AND id=$2",
          [g.tenantId, g.flowId],
        );
      const receiptId = randomUUID();
      await tx.query(
        `INSERT INTO verified_identity_receipts(tenant_id,id,flow_id,site_id,identity_id,subject_issuer,nonce_digest,assertion_digest,verified_at,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          g.tenantId,
          receiptId,
          g.flowId,
          f.siteId,
          identity!.id,
          receipt.issuer,
          digest(receipt.nonceDigest),
          digest(receipt.assertionDigest),
          receipt.verifiedAt,
          receipt.expiresAt,
        ],
      );
      const op = await one(
        tx,
        `INSERT INTO binding_operations(tenant_id,id,flow_id,receipt_id,source_attachment_id,candidate_profile_id,identity_id,result_binding_id,result_profile_id,expected_identity_revision,state)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [
          g.tenantId,
          randomUUID(),
          g.flowId,
          receiptId,
          g.attachmentId,
          g.profileId,
          identity!.id,
          binding!.id,
          binding!.profile_id,
          identity!.revision,
          adopted ? "adopted" : "switch_pending",
        ],
      );
      await tx.query(
        "UPDATE identities SET last_authorized_use_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",
        [g.tenantId, identity!.id],
      );
      return this.bindingResult(op!);
    });
  }
  async createWarmAttachment(
    tenantId: string,
    flowId: string,
    bindingOperationId: string,
  ): Promise<FlowRecord> {
    await this.tx(async (tx) => {
      const b = await one(
        tx,
        "SELECT * FROM binding_operations WHERE tenant_id=$1 AND id=$2 AND flow_id=$3 FOR UPDATE",
        [tenantId, bindingOperationId, flowId],
      );
      if (!b) error("Binding operation not found", "binding_not_found", 404);
      if (b!.state === "switched") return;
      if (b!.state !== "switch_pending")
        error("Binding does not require switching", "binding_state");
      if (
        await one(
          tx,
          "SELECT 1 FROM browser_leases WHERE tenant_id=$1 AND flow_id=$2 AND released_at IS NULL",
          [tenantId, flowId],
        )
      )
        error(
          "Anonymous browser must be stopped and released first",
          "lease_held",
        );
      const f = await this.flow(tx, tenantId, flowId);
      const identity = await one(
        tx,
        "SELECT * FROM identities WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [tenantId, b!.identity_id],
      );
      if (identity!.tombstoned_at)
        error("Identity was retired", "identity_unavailable");
      const current = await one(
        tx,
        "SELECT id FROM identity_bindings WHERE tenant_id=$1 AND identity_id=$2 AND profile_id=$3 AND retired_at IS NULL",
        [tenantId, b!.identity_id, b!.result_profile_id],
      );
      if (current?.id !== b!.result_binding_id)
        error("Warm binding changed while waiting", "binding_changed");
      if (
        !(await one(
          tx,
          "SELECT 1 FROM profile_replicas WHERE tenant_id=$1 AND profile_id=$2 AND node_id=$3 AND role='authoritative' AND retired_at IS NULL",
          [tenantId, b!.result_profile_id, f.nodeId],
        ))
      )
        error(
          "Warm profile is on another node; controlled migration is required",
          "migration_required",
        );
      await tx.query(
        `INSERT INTO flow_session_attachments(tenant_id,id,flow_id,site_id,profile_id,identity_id,binding_id,bound_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp())`,
        [
          tenantId,
          randomUUID(),
          flowId,
          f.siteId,
          b!.result_profile_id,
          b!.identity_id,
          b!.result_binding_id,
        ],
      );
      await tx.query(
        "UPDATE binding_operations SET state='switched' WHERE tenant_id=$1 AND id=$2",
        [tenantId, bindingOperationId],
      );
      await this.retireAnonymous(tx, tenantId, b!.candidate_profile_id);
      await tx.query(
        "UPDATE flow_instances SET state='queued',wait_reason=NULL,document_epoch=document_epoch+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",
        [tenantId, flowId],
      );
    });
    return this.getFlow(tenantId, flowId);
  }
  async requeueFlow(tenantId: string, flowId: string): Promise<FlowRecord> {
    await this.tx(async (tx) => {
      const f = await this.flow(tx, tenantId, flowId);
      await tx.query(
        "SELECT id FROM flow_instances WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [tenantId, flowId],
      );
      if (
        await one(
          tx,
          "SELECT 1 FROM browser_leases WHERE tenant_id=$1 AND flow_id=$2 AND released_at IS NULL",
          [tenantId, flowId],
        )
      )
        error("Flow still owns a lease", "lease_held");
      if (
        !(await one(
          tx,
          "SELECT 1 FROM flow_session_attachments WHERE tenant_id=$1 AND flow_id=$2 AND closed_at IS NULL",
          [tenantId, flowId],
        ))
      )
        await tx.query(
          `INSERT INTO flow_session_attachments(tenant_id,id,flow_id,site_id,profile_id,identity_id,binding_id,bound_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,CASE WHEN $6::uuid IS NOT NULL THEN clock_timestamp() END)`,
          [
            tenantId,
            randomUUID(),
            flowId,
            f.siteId,
            f.profileId,
            f.identityId ?? null,
            f.bindingId ?? null,
          ],
        );
      await tx.query(
        "UPDATE flow_instances SET state='queued',wait_reason=NULL,updated_at=clock_timestamp(),document_epoch=document_epoch+1 WHERE tenant_id=$1 AND id=$2",
        [tenantId, flowId],
      );
    });
    return this.getFlow(tenantId, flowId);
  }
  async resumeFlow(tenantId: string, flowId: string): Promise<FlowRecord> {
    return this.requeueFlow(tenantId, flowId);
  }
  async resumeRetainedFlow(
    tenantId: string,
    flowId: string,
    currentIncarnationId: string,
    ttlMs = 45_000,
  ): Promise<LeaseGrant | null> {
    if (ttlMs < 100 || ttlMs > 300_000)
      error("Invalid lease duration", "invalid_ttl", 400);
    return this.tx(async (tx) => {
      const f = await this.flow(tx, tenantId, flowId);
      const d = await one(
        tx,
        "SELECT *,starts_blocked_until>clock_timestamp() AS cooling FROM quota_domains WHERE id=$1 FOR UPDATE",
        [f.quotaDomainId],
      );
      if (!d || d.admission_state !== "open" || d.cooling) return null;
      if (f.identityId) {
        const identity = await one(
          tx,
          "SELECT * FROM identities WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
          [tenantId, f.identityId],
        );
        if (identity!.tombstoned_at || identity!.state !== "ready")
          error("Identity is unavailable", "identity_unavailable");
      }
      const p = await one(
        tx,
        "SELECT * FROM logical_profiles WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [tenantId, f.profileId],
      );
      if (p!.tombstoned_at || ["quarantined", "retired"].includes(p!.state))
        error("Profile is unavailable", "profile_unavailable");
      const node = await one(
        tx,
        "SELECT * FROM engine_nodes WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [tenantId, f.nodeId],
      );
      const inc = await one(
        tx,
        "SELECT * FROM node_incarnations WHERE tenant_id=$1 AND id=$2 AND node_id=$3",
        [tenantId, currentIncarnationId, f.nodeId],
      );
      if (
        !node ||
        !inc ||
        inc.fenced_at ||
        number(node.agent_epoch) !== number(inc.agent_epoch)
      )
        error("Node incarnation is stale", "stale_incarnation");
      if (!["ready", "recovering"].includes(node!.state))
        error("Node is administratively unavailable", "node_unavailable");
      const old = await one(
        tx,
        "SELECT * FROM browser_leases WHERE tenant_id=$1 AND flow_id=$2 AND released_at IS NULL FOR UPDATE",
        [tenantId, flowId],
      );
      if (!old)
        return error("Flow has no retained lease", "lease_not_found", 404);
      if (!old.capacity_released_at || !old.stop_barrier_id)
        error(
          "Retained browser must first be proven stopped",
          "stop_not_confirmed",
        );
      if (
        await one(
          tx,
          "SELECT 1 FROM lifecycle_operations WHERE tenant_id=$1 AND lease_id=$2 AND resolved_at IS NULL",
          [tenantId, old.id],
        )
      )
        error("Retained lifecycle work is unresolved", "operation_pending");
      if (new Date(f.deadlineAt).getTime() <= Date.now())
        error("Flow absolute deadline has expired", "deadline_expired");
      const counts = await one(
        tx,
        "SELECT count(*) AS total,count(*) FILTER(WHERE mobile) AS mobile FROM browser_leases WHERE quota_domain_id=$1 AND capacity_released_at IS NULL",
        [f.quotaDomainId],
      );
      if (
        number(counts!.total) >= d.total_browser_budget ||
        (old.mobile && number(counts!.mobile) >= d.mobile_browser_budget)
      )
        return null;
      const occupied = await one(
        tx,
        "SELECT count(*) AS n FROM browser_leases WHERE tenant_id=$1 AND node_id=$2 AND capacity_released_at IS NULL",
        [tenantId, f.nodeId],
      );
      if (number(occupied!.n) >= node!.max_browsers) return null;
      if (
        await one(
          tx,
          `SELECT 1 FROM browser_leases WHERE tenant_id=$1 AND node_id=$2 AND node_incarnation_id<>$3 AND capacity_released_at IS NULL LIMIT 1`,
          [tenantId, f.nodeId, currentIncarnationId],
        )
      )
        error("Another old browser remains uncertain", "node_quarantined");
      const epoch = await one(
        tx,
        "UPDATE logical_profiles SET lease_epoch=lease_epoch+1 WHERE tenant_id=$1 AND id=$2 RETURNING lease_epoch",
        [tenantId, f.profileId],
      );
      await tx.query(
        "UPDATE browser_leases SET state='released',released_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",
        [tenantId, old.id],
      );
      await tx.query(
        "UPDATE flow_session_attachments SET closed_at=clock_timestamp(),closure_reason='fenced_same_flow_resume' WHERE tenant_id=$1 AND id=$2",
        [tenantId, old.attachment_id],
      );
      const attachmentId = randomUUID(),
        leaseId = randomUUID();
      await tx.query(
        `INSERT INTO flow_session_attachments(tenant_id,id,flow_id,site_id,profile_id,identity_id,binding_id,bound_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,CASE WHEN $6::uuid IS NOT NULL THEN clock_timestamp() END)`,
        [
          tenantId,
          attachmentId,
          flowId,
          f.siteId,
          f.profileId,
          old.identity_id,
          old.binding_id,
        ],
      );
      await tx.query(
        `INSERT INTO browser_leases(tenant_id,id,flow_id,attachment_id,identity_id,binding_id,profile_id,replica_id,quota_domain_id,node_id,node_incarnation_id,lease_epoch,mobile,authorization_expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,clock_timestamp()+$14*interval '1 millisecond')`,
        [
          tenantId,
          leaseId,
          flowId,
          attachmentId,
          old.identity_id,
          old.binding_id,
          f.profileId,
          old.replica_id,
          f.quotaDomainId,
          f.nodeId,
          currentIncarnationId,
          epoch!.lease_epoch,
          old.mobile,
          ttlMs,
        ],
      );
      await tx.query(
        "UPDATE engine_nodes SET state='ready' WHERE tenant_id=$1 AND id=$2",
        [tenantId, f.nodeId],
      );
      await tx.query(
        "UPDATE flow_instances SET state='preparing',wait_reason='reconcile_pending_action',owner_epoch=owner_epoch+1,owner_id=$3,owner_expires_at=clock_timestamp()+$4*interval '1 millisecond',document_epoch=document_epoch+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",
        [tenantId, flowId, currentIncarnationId, ttlMs],
      );
      return this.grant(tx, tenantId, leaseId);
    });
  }
  async findIdentity(
    tenantId: string,
    siteId: string,
    issuer: string,
    subjectKey: string,
    hmacKeyVersion = 1,
  ): Promise<string | null> {
    return this.tx(
      async (tx) =>
        (
          await one(
            tx,
            "SELECT identity_id FROM identity_subject_aliases WHERE tenant_id=$1 AND site_id=$2 AND subject_issuer=$3 AND subject_key=$4 AND hmac_key_version=$5",
            [tenantId, siteId, issuer, subjectKey, hmacKeyVersion],
          )
        )?.identity_id ?? null,
    );
  }
  private async retireAnonymous(
    tx: SqlExecutor,
    tenantId: string,
    profileId: string,
  ): Promise<void> {
    await tx.query(
      "SELECT id FROM logical_profiles WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
      [tenantId, profileId],
    );
    if (
      await one(
        tx,
        "SELECT 1 FROM browser_leases WHERE tenant_id=$1 AND profile_id=$2 AND released_at IS NULL",
        [tenantId, profileId],
      )
    )
      error("Profile still has a holder", "lease_held");
    if (
      await one(
        tx,
        "SELECT 1 FROM identity_bindings WHERE tenant_id=$1 AND profile_id=$2",
        [tenantId, profileId],
      )
    )
      error(
        "Identity profile cannot be retired as anonymous",
        "profile_is_bound",
      );
    await tx.query(
      "UPDATE logical_profiles SET state='retired',revision=revision+1 WHERE tenant_id=$1 AND id=$2",
      [tenantId, profileId],
    );
  }
  async retireAnonymousProfile(
    tenantId: string,
    profileId: string,
  ): Promise<void> {
    await this.tx((tx) => this.retireAnonymous(tx, tenantId, profileId));
  }
  async claimProxyExit(
    g: LeaseGrant,
    exitIp: string,
    report: JsonObject = {},
  ): Promise<boolean> {
    if (!isIP(exitIp))
      error("Observed exit must be one IP address", "invalid_ip", 400);
    return this.tx(async (tx) => {
      await tx.query("SELECT id FROM quota_domains WHERE id=$1 FOR UPDATE", [
        g.quotaDomainId,
      ]);
      await this.lockedLease(tx, g, true);
      const address = (await one(
        tx,
        `SELECT CASE WHEN $1::inet <<= '::ffff:0:0/96'::inet THEN '0.0.0.0'::inet+($1::inet-'::ffff:0:0'::inet) ELSE $1::inet END AS ip`,
        [exitIp],
      ))!.ip;
      const existing = await one(
        tx,
        "SELECT lease_id FROM proxy_exit_claims WHERE quota_domain_id=$1 AND exit_ip=$2::inet AND released_at IS NULL",
        [g.quotaDomainId, address],
      );
      if (existing) return existing.lease_id === g.id;
      const claim = await one(
        tx,
        `INSERT INTO proxy_exit_claims(id,tenant_id,lease_id,quota_domain_id,exit_ip,report)
        VALUES($1,$2,$3,$4,$5::inet,$6::jsonb) ON CONFLICT DO NOTHING RETURNING id`,
        [
          randomUUID(),
          g.tenantId,
          g.id,
          g.quotaDomainId,
          address,
          json(report),
        ],
      );
      return !!claim;
    });
  }
  async releaseProxyExit(g: LeaseGrant): Promise<void> {
    await this.tx(async (tx) => {
      await tx.query("SELECT id FROM quota_domains WHERE id=$1 FOR UPDATE", [
        g.quotaDomainId,
      ]);
      const l = await one(
        tx,
        "SELECT * FROM browser_leases WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [g.tenantId, g.id],
      );
      if (
        !l ||
        l.profile_id !== g.profileId ||
        number(l.lease_epoch) !== g.epoch
      )
        error("Lease fence does not match", "stale_lease");
      if (!l!.stop_barrier_id || !l!.capacity_released_at)
        error(
          "Proxy exit stays reserved until browser stop is proven",
          "stop_not_confirmed",
        );
      await tx.query(
        "UPDATE proxy_exit_claims SET released_at=coalesce(released_at,clock_timestamp()) WHERE tenant_id=$1 AND lease_id=$2",
        [g.tenantId, g.id],
      );
    });
  }
  async readFlowData(
    tenantId: string,
    flowId: string,
  ): Promise<{
    metadata: JsonObject;
    checkpoint: JsonObject;
    revision: number;
  }> {
    return this.tx(async (tx) => {
      const r = await one(
        tx,
        "SELECT * FROM flow_runtime_data WHERE tenant_id=$1 AND flow_id=$2",
        [tenantId, flowId],
      );
      if (!r) return error("Flow not found", "flow_not_found", 404);
      return {
        metadata: r.metadata,
        checkpoint: r.checkpoint,
        revision: number(r.revision),
      };
    });
  }
  async checkpoint(
    tenantId: string,
    flowId: string,
    value:
      | JsonObject
      | {
          metadata?: JsonObject;
          checkpoint?: JsonObject;
          expectedRevision?: number;
          grant?: LeaseGrant;
          event?: JsonObject;
        },
    expectedRevision?: number,
    grant?: LeaseGrant,
  ): Promise<number> {
    const update = (
      expectedRevision !== undefined || grant !== undefined
        ? { checkpoint: value as JsonObject, expectedRevision, grant }
        : value
    ) as {
      metadata?: JsonObject;
      checkpoint?: JsonObject;
      expectedRevision?: number;
      grant?: LeaseGrant;
      event?: JsonObject;
    };
    return this.tx(async (tx) => {
      if (update.grant) {
        if (
          update.grant.tenantId !== tenantId ||
          update.grant.flowId !== flowId
        )
          error("Checkpoint scope differs from lease", "stale_lease");
        const l = await this.lockedLease(tx, update.grant);
        if (
          number(l.current_epoch) !== update.grant.epoch ||
          number(l.current_agent_epoch) !== number(l.owner_agent_epoch)
        )
          error("Checkpoint owner is stale", "stale_lease");
      }
      const current = await one(
        tx,
        "SELECT * FROM flow_runtime_data WHERE tenant_id=$1 AND flow_id=$2 FOR UPDATE",
        [tenantId, flowId],
      );
      if (!current) error("Flow not found", "flow_not_found", 404);
      if (
        update.expectedRevision !== undefined &&
        number(current!.revision) !== update.expectedRevision
      )
        error("Flow checkpoint changed", "revision_conflict");
      const r = await one(
        tx,
        "UPDATE flow_runtime_data SET metadata=coalesce($3::jsonb,metadata),checkpoint=coalesce($4::jsonb,checkpoint),revision=revision+1 WHERE tenant_id=$1 AND flow_id=$2 RETURNING revision",
        [
          tenantId,
          flowId,
          update.metadata === undefined ? null : json(update.metadata),
          update.checkpoint === undefined ? null : json(update.checkpoint),
        ],
      );
      if (update.checkpoint) {
        const c = update.checkpoint;
        await tx.query(
          "UPDATE flow_instances SET next_step_id=$3,step_visit_counts=$4::jsonb,consumed_budgets=$5::jsonb,updated_at=clock_timestamp(),revision=revision+1 WHERE tenant_id=$1 AND id=$2",
          [
            tenantId,
            flowId,
            typeof c.stepId === "string" ? c.stepId : null,
            json(c.visits),
            json(c.budgets),
          ],
        );
      }
      if (update.event)
        await tx.query(
          "INSERT INTO flow_events(tenant_id,flow_id,event) VALUES($1,$2,$3::jsonb)",
          [tenantId, flowId, json(update.event)],
        );
      return number(r!.revision);
    });
  }
  async updateMetadata(
    tenantId: string,
    flowId: string,
    patch: JsonObject,
  ): Promise<void> {
    await this.tx(async (tx) => {
      const result = await tx.query(
        "UPDATE flow_runtime_data SET metadata=metadata||$3::jsonb WHERE tenant_id=$1 AND flow_id=$2",
        [tenantId, flowId, json(patch)],
      );
      if (result.rowCount === 0) error("Flow not found", "flow_not_found", 404);
    });
  }
  async appendEvent(
    tenantId: string,
    flowId: string,
    event: JsonObject,
  ): Promise<void> {
    await this.tx(async (tx) => {
      await tx.query(
        "INSERT INTO flow_events(tenant_id,flow_id,event) VALUES($1,$2,$3::jsonb)",
        [tenantId, flowId, json(event)],
      );
    });
  }
  async listEvents(
    tenantId: string,
    flowId: string,
    after = 0,
    limit = 100,
  ): Promise<{ sequence: number; event: JsonObject; createdAt: string }[]> {
    return this.tx(async (tx) =>
      (
        await tx.query<Row>(
          "SELECT * FROM flow_events WHERE tenant_id=$1 AND flow_id=$2 AND sequence>$3 ORDER BY sequence LIMIT $4",
          [tenantId, flowId, after, Math.min(1000, Math.max(1, limit))],
        )
      ).rows.map((r) => ({
        sequence: number(r.sequence),
        event: r.event,
        createdAt: iso(r.created_at),
      })),
    );
  }
  async recordObservation(
    g: LeaseGrant,
    observation: {
      sequence: number;
      documentEpoch: number;
      targetKey: string;
      frameKey: string;
      artifactKey?: string;
    },
  ): Promise<void> {
    await this.tx(async (tx) => {
      await this.lockedLease(tx, g, true);
      const f = await one(
        tx,
        "SELECT * FROM flow_instances WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [g.tenantId, g.flowId],
      );
      if (
        observation.sequence <= number(f!.observation_seq) ||
        observation.documentEpoch < number(f!.document_epoch)
      )
        error("Observation is stale", "stale_observation");
      await tx.query(
        `INSERT INTO flow_observations(tenant_id,flow_id,lease_id,lease_epoch,sequence,document_epoch,target_key,frame_key,observed_at,sanitized_artifact_key)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp(),$9)`,
        [
          g.tenantId,
          g.flowId,
          g.id,
          g.epoch,
          observation.sequence,
          observation.documentEpoch,
          observation.targetKey,
          observation.frameKey,
          observation.artifactKey ?? null,
        ],
      );
      await tx.query(
        "UPDATE flow_instances SET observation_seq=$3,document_epoch=$4 WHERE tenant_id=$1 AND id=$2",
        [g.tenantId, g.flowId, observation.sequence, observation.documentEpoch],
      );
    });
  }
  async journalAction(
    g: LeaseGrant,
    action: {
      id?: string;
      sequence: number;
      documentEpoch: number;
      observationSeq: number;
      targetKey: string;
      frameKey: string;
      kind: string;
      intentDigest: string;
      effect?: { scope: string; key: string };
    },
  ): Promise<{ id: string; state: string }> {
    return this.tx(async (tx) => {
      const l = await this.lockedLease(tx, g, true),
        id = action.id ?? randomUUID();
      const old = await one(
        tx,
        "SELECT * FROM action_journal WHERE tenant_id=$1 AND id=$2",
        [g.tenantId, id],
      );
      if (old) {
        if (
          old.lease_id !== g.id ||
          Buffer.from(old.intent_digest).toString("hex") !==
            action.intentDigest.toLowerCase()
        )
          error("Action ID has another intent", "action_conflict");
        return { id: old.id, state: old.state };
      }
      const f = await one(
        tx,
        "SELECT * FROM flow_instances WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [g.tenantId, g.flowId],
      );
      if (
        number(f!.document_epoch) !== action.documentEpoch ||
        number(f!.observation_seq) !== action.observationSeq
      )
        error("Action grounding is stale", "stale_observation");
      let effectId: string | null = null;
      if (action.effect) {
        const effect = await one(
          tx,
          `SELECT * FROM effect_claims WHERE tenant_id=$1 AND effect_scope=$2 AND effect_key=$3 AND
        (($4::uuid IS NOT NULL AND identity_id=$4) OR ($4::uuid IS NULL AND anonymous_flow_id=$5)) FOR UPDATE`,
          [
            g.tenantId,
            action.effect.scope,
            action.effect.key,
            l.identity_id,
            g.flowId,
          ],
        );
        if (effect) {
          if (effect.state !== "rejected")
            error(
              "Effect key already has a pending or confirmed outcome",
              effect.state === "confirmed"
                ? "effect_confirmed"
                : "effect_pending",
            );
          effectId = effect.id;
          await tx.query(
            "UPDATE effect_claims SET state='claimed' WHERE tenant_id=$1 AND id=$2",
            [g.tenantId, effectId],
          );
        } else {
          effectId = randomUUID();
          await tx.query(
            "INSERT INTO effect_claims(tenant_id,id,identity_id,anonymous_flow_id,effect_scope,effect_key) VALUES($1,$2,$3,$4,$5,$6)",
            [
              g.tenantId,
              effectId,
              l.identity_id,
              l.identity_id ? null : g.flowId,
              action.effect.scope,
              action.effect.key,
            ],
          );
        }
      }
      const row = await one(
        tx,
        `INSERT INTO action_journal(tenant_id,id,flow_id,identity_id,lease_id,lease_epoch,action_sequence,document_epoch,grounding_observation_seq,target_key,frame_key,action_kind,intent_digest,effect_claim_id,effect_anonymous_flow_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id,state`,
        [
          g.tenantId,
          id,
          g.flowId,
          l.identity_id,
          g.id,
          g.epoch,
          action.sequence,
          action.documentEpoch,
          action.observationSeq,
          action.targetKey,
          action.frameKey,
          action.kind,
          digest(action.intentDigest),
          effectId,
          effectId && !l.identity_id ? g.flowId : null,
        ],
      );
      return { id: row!.id, state: row!.state };
    });
  }
  async markActionDispatched(g: LeaseGrant, actionId: string): Promise<void> {
    await this.tx(async (tx) => {
      await this.lockedLease(tx, g, true);
      const r = await one(
        tx,
        "UPDATE action_journal SET state='dispatched',dispatched_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND lease_id=$3 AND state='intent' RETURNING id",
        [g.tenantId, actionId, g.id],
      );
      if (!r) error("Action is not dispatchable", "action_not_pending");
    });
  }
  async resolveAction(
    g: LeaseGrant,
    actionId: string,
    result: {
      state:
        | "completed"
        | "rejected"
        | "cancelled_before_dispatch"
        | "unknown"
        | "reconciled";
      completion?: {
        observationSeq: number;
        documentEpoch: number;
        targetKey: string;
        frameKey: string;
      };
      effectOutcome?: "confirmed" | "rejected";
    },
  ): Promise<void> {
    await this.tx(async (tx) => {
      await this.lockedLease(tx, g);
      const a = await one(
        tx,
        "SELECT * FROM action_journal WHERE tenant_id=$1 AND id=$2 AND flow_id=$3 FOR UPDATE",
        [g.tenantId, actionId, g.flowId],
      );
      if (!a) error("Action not found", "action_not_found", 404);
      if (a!.lease_id !== g.id) {
        await this.lockedLease(tx, g, true);
        const prior = await one(
          tx,
          "SELECT * FROM browser_leases WHERE tenant_id=$1 AND id=$2",
          [g.tenantId, a!.lease_id],
        );
        if (
          !prior?.released_at ||
          !prior.stop_barrier_id ||
          prior.profile_id !== g.profileId ||
          result.state !== "reconciled"
        )
          error(
            "Historical action requires fenced same-profile reconciliation",
            "stale_action",
          );
      }
      if (a!.resolved_at) {
        if (a!.state !== result.state)
          error("Action was already resolved", "action_resolved");
        return;
      }
      if (result.state === "cancelled_before_dispatch" && a!.state !== "intent")
        error("Dispatched action has an uncertain effect", "action_pending");
      if (result.state === "completed" && !result.completion)
        error(
          "Completion needs a postcondition observation",
          "observation_required",
        );
      if (
        result.state === "reconciled" &&
        a!.effect_claim_id &&
        !result.effectOutcome
      )
        error(
          "Reconciled effect needs a definite outcome",
          "effect_outcome_required",
        );
      const c = result.completion;
      await tx.query(
        `UPDATE action_journal SET state=$4,resolved_at=CASE WHEN $4='unknown' THEN NULL ELSE clock_timestamp() END,completion_observation_seq=$5,completion_document_epoch=$6,completion_target_key=$7,completion_frame_key=$8
      WHERE tenant_id=$1 AND id=$2 AND lease_id=$3`,
        [
          g.tenantId,
          actionId,
          a!.lease_id,
          result.state,
          c?.observationSeq ?? null,
          c?.documentEpoch ?? null,
          c?.targetKey ?? null,
          c?.frameKey ?? null,
        ],
      );
      if (a!.effect_claim_id)
        await tx.query(
          "UPDATE effect_claims SET state=$3 WHERE tenant_id=$1 AND id=$2",
          [
            g.tenantId,
            a!.effect_claim_id,
            result.effectOutcome ??
              (result.state === "completed"
                ? "confirmed"
                : result.state === "unknown"
                  ? "unknown"
                  : "rejected"),
          ],
        );
    });
  }
  private snapshotRecord(s: Row): SnapshotRecord {
    return {
      id: s.id,
      profileId: s.profile_id,
      generation: number(s.generation),
      state: s.state,
      objectKey: s.object_key,
      sha256: s.sha256 ? Buffer.from(s.sha256).toString("hex") : undefined,
      bytes: s.byte_length === null ? undefined : number(s.byte_length),
    };
  }
  async stageSnapshot(
    g: LeaseGrant,
    input: SnapshotInput,
  ): Promise<SnapshotRecord> {
    return this.tx(async (tx) => {
      const l = await this.lockedLease(tx, g);
      if (!l.stop_barrier_id || !l.capacity_released_at)
        error("Snapshot requires a stopped browser", "stop_not_confirmed");
      const p = await one(
        tx,
        "SELECT * FROM logical_profiles WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [g.tenantId, g.profileId],
      );
      if (p!.tombstoned_at) error("Profile was retired", "profile_unavailable");
      const op = await one(
        tx,
        "SELECT * FROM lifecycle_operations WHERE tenant_id=$1 AND id=$2 AND lease_id=$3 AND kind='export' AND state='succeeded'",
        [g.tenantId, input.exportOperationId, g.id],
      );
      if (!op)
        error(
          "Export success must be recorded before staging",
          "export_not_confirmed",
        );
      const existing = await one(
        tx,
        "SELECT * FROM profile_snapshots WHERE tenant_id=$1 AND object_key=$2",
        [g.tenantId, input.objectKey],
      );
      if (existing) {
        if (
          existing.profile_id !== g.profileId ||
          Buffer.from(existing.sha256).toString("hex") !==
            input.sha256.toLowerCase()
        )
          error("Immutable object key collision", "snapshot_conflict");
        return this.snapshotRecord(existing);
      }
      const generation = number(
        (await one(
          tx,
          "SELECT coalesce(max(generation),0)+1 AS n FROM profile_snapshots WHERE tenant_id=$1 AND profile_id=$2",
          [g.tenantId, g.profileId],
        ))!.n,
      );
      const s = await one(
        tx,
        `INSERT INTO profile_snapshots(tenant_id,id,profile_id,binding_id,lease_id,export_operation_id,generation,state,object_key,sha256,byte_length,engine_version,kernel_version,expected_profile_revision,expected_predecessor_generation)
      VALUES($1,$2,$3,$4,$5,$6,$7,'verified',$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [
          g.tenantId,
          input.id ?? randomUUID(),
          g.profileId,
          l.binding_id,
          g.id,
          input.exportOperationId,
          generation,
          input.objectKey,
          digest(input.sha256),
          input.bytes,
          input.engineVersion,
          input.kernelVersion,
          p!.revision,
          p!.snapshot_generation,
        ],
      );
      return this.snapshotRecord(s!);
    });
  }
  async publishSnapshot(
    g: LeaseGrant,
    snapshotId: string,
    expectedRevision?: number,
  ): Promise<SnapshotRecord> {
    return this.tx(async (tx) => {
      const l = await this.lockedLease(tx, g);
      if (l.identity_id) {
        const identity = await one(
          tx,
          "SELECT * FROM identities WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
          [g.tenantId, l.identity_id],
        );
        if (identity!.tombstoned_at)
          error("Identity was retired", "identity_unavailable");
      }
      const p = await one(
        tx,
        "SELECT * FROM logical_profiles WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [g.tenantId, g.profileId],
      );
      if (
        expectedRevision !== undefined &&
        number(p!.revision) !== expectedRevision
      )
        error("Profile revision changed", "snapshot_stale");
      const s = await one(
        tx,
        "SELECT * FROM profile_snapshots WHERE tenant_id=$1 AND id=$2 AND lease_id=$3 FOR UPDATE",
        [g.tenantId, snapshotId, g.id],
      );
      if (!s) error("Snapshot not found", "snapshot_not_found", 404);
      if (s!.state === "published" && p!.published_snapshot_id === s!.id)
        return this.snapshotRecord(s!);
      if (
        p!.tombstoned_at ||
        number(p!.lease_epoch) !== g.epoch ||
        number(p!.revision) !== number(s!.expected_profile_revision) ||
        number(p!.snapshot_generation) !==
          number(s!.expected_predecessor_generation) ||
        s!.state !== "verified"
      )
        error("Snapshot publication fence changed", "snapshot_stale");
      if (
        await one(
          tx,
          "SELECT 1 FROM lifecycle_operations WHERE tenant_id=$1 AND lease_id=$2 AND resolved_at IS NULL",
          [g.tenantId, g.id],
        )
      )
        error("Lifecycle work remains uncertain", "operation_pending");
      await tx.query(
        "UPDATE profile_snapshots SET state='published',published_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",
        [g.tenantId, snapshotId],
      );
      await tx.query(
        "UPDATE logical_profiles SET published_snapshot_id=$3,snapshot_generation=$4,revision=revision+1 WHERE tenant_id=$1 AND id=$2",
        [g.tenantId, g.profileId, snapshotId, s!.generation],
      );
      return this.snapshotRecord({ ...s!, state: "published" });
    });
  }
  async tombstoneIdentity(tenantId: string, identityId: string): Promise<void> {
    await this.tx(async (tx) => {
      const i = await one(
        tx,
        "UPDATE identities SET tombstoned_at=coalesce(tombstoned_at,clock_timestamp()),purge_state='pending',state='retired',revision=revision+1 WHERE tenant_id=$1 AND id=$2 RETURNING id",
        [tenantId, identityId],
      );
      if (!i) error("Identity not found", "identity_not_found", 404);
      await tx.query(
        "UPDATE logical_profiles SET tombstoned_at=coalesce(tombstoned_at,clock_timestamp()),state='quarantined',revision=revision+1 WHERE tenant_id=$1 AND id IN(SELECT profile_id FROM identity_bindings WHERE tenant_id=$1 AND identity_id=$2)",
        [tenantId, identityId],
      );
      await tx.query(
        "UPDATE browser_leases SET state='revoking' WHERE tenant_id=$1 AND identity_id=$2 AND released_at IS NULL",
        [tenantId, identityId],
      );
    });
  }
  async stats(quotaDomainId: string): Promise<CoordinatorStats> {
    return this.tx(async (tx) => {
      const r = await one(
        tx,
        `SELECT d.total_browser_budget,d.mobile_browser_budget,d.starts_blocked_until,
      (SELECT count(*) FROM browser_leases l WHERE l.quota_domain_id=d.id AND l.capacity_released_at IS NULL) AS charged,
      (SELECT count(*) FROM browser_leases l WHERE l.quota_domain_id=d.id AND l.capacity_released_at IS NULL AND l.mobile) AS mobile,
      (SELECT count(*) FROM browser_leases l WHERE l.quota_domain_id=d.id AND l.released_at IS NULL) AS held,
      (SELECT count(*) FROM browser_leases l WHERE l.quota_domain_id=d.id AND l.released_at IS NULL AND l.state='quarantined') AS quarantined,
      (SELECT count(*) FROM flow_assignments a JOIN flow_instances f ON f.tenant_id=a.tenant_id AND f.id=a.flow_id WHERE a.quota_domain_id=d.id AND f.state='queued') AS queued,
      (SELECT count(*) FROM lifecycle_operations o JOIN browser_leases l ON l.tenant_id=o.tenant_id AND l.id=o.lease_id WHERE l.quota_domain_id=d.id AND o.resolved_at IS NULL) AS pending
      FROM quota_domains d WHERE d.id=$1`,
        [quotaDomainId],
      );
      if (!r) error("Quota domain not found", "quota_domain_not_found", 404);
      return {
        chargedBrowsers: number(r!.charged),
        chargedMobile: number(r!.mobile),
        heldProfiles: number(r!.held),
        quarantinedLeases: number(r!.quarantined),
        queuedFlows: number(r!.queued),
        pendingOperations: number(r!.pending),
        totalBrowserBudget: number(r!.total_browser_budget),
        mobileBrowserBudget: number(r!.mobile_browser_budget),
        startsBlockedUntil: Number.isFinite(
          new Date(r!.starts_blocked_until).getTime(),
        )
          ? iso(r!.starts_blocked_until)
          : null,
      };
    });
  }
  async close() {
    await this.db.close?.();
  }
}
