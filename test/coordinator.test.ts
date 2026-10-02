import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import {
  DurableCoordinator,
  PgDatabase,
  type SqlDatabase,
  type SqlExecutor,
  type SqlResult,
  type LeaseGrant,
  type WorkspaceConfig,
} from "../src/coordinator/index.js";

const hex = (s: string) => createHash("sha256").update(s).digest("hex");
class MemoryPostgres implements SqlDatabase {
  readonly engine = new PGlite();
  async query<T>(sql: string, values?: unknown[]): Promise<SqlResult<T>> {
    const r = values
      ? await this.engine.query(sql, values)
      : (await this.engine.exec(sql)).at(-1);
    return { rows: (r?.rows ?? []) as T[], rowCount: r?.affectedRows };
  }
  async transaction<T>(body: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return this.engine.transaction(async (tx) =>
      body({
        query: async <R>(sql: string, values?: unknown[]) => {
          const r = values
            ? await tx.query(sql, values)
            : (await tx.exec(sql)).at(-1);
          return { rows: (r?.rows ?? []) as R[], rowCount: r?.affectedRows };
        },
      }),
    );
  }
  async close() {
    await this.engine.close();
  }
}
async function fixture(total = 2) {
  const db = new MemoryPostgres(),
    coordinator = new DurableCoordinator({ db });
  await coordinator.migrate();
  await coordinator.migrate();
  const config: WorkspaceConfig = {
    tenantId: randomUUID(),
    siteId: randomUUID(),
    quotaDomainId: randomUUID(),
    vendorTeamKey: randomUUID(),
    nodeId: randomUUID(),
    nodeIncarnationId: randomUUID(),
    engineProcessKey: randomUUID(),
    origin: "https://owned.test",
    totalBrowserBudget: total,
    nodeMaxBrowsers: total,
  };
  await coordinator.ensureWorkspace(config);
  const submit = async (requestId = randomUUID()) =>
    coordinator.submitFlow({
      tenantId: config.tenantId,
      siteId: config.siteId,
      quotaDomainId: config.quotaDomainId,
      nodeId: config.nodeId,
      pack: {
        key: "fixture",
        version: "1",
        hash: hex("pack"),
        artifactKey: "fixture.json",
      },
      requestId,
      deadlineAt: new Date(Date.now() + 600_000).toISOString(),
    });
  let localSequence = 0;
  const op = async (
    g: LeaseGrant,
    kind: "create" | "start" | "stop" | "export",
  ) => {
    const p = await coordinator.beginOperation(g, {
      kind,
      requestDigest: hex(kind),
      deadlineAt: new Date(Date.now() + 30_000).toISOString(),
    });
    await coordinator.markDispatched(g, p.id);
    await coordinator.resolveOperation(g, p.id, { state: "succeeded" });
    return p;
  };
  const stop = async (g: LeaseGrant) => {
    const p = await op(g, "stop");
    return coordinator.confirmStopped(g, {
      kind: "drained_and_stopped",
      evidenceDigest: hex("stop"),
      localSequence: ++localSequence,
      coversLifecycleSequence: p.sequence,
    });
  };
  return { db, c: coordinator, config, submit, op, stop };
}
test("durable admission preserves charged capacity and profile exclusivity after expiry", async () => {
  const f = await fixture(1);
  try {
    const first = await f.submit(),
      second = await f.submit();
    const grant = await f.c.acquire({
      tenantId: f.config.tenantId,
      flowId: first.id,
    });
    assert.ok(grant);
    assert.equal(
      await f.c.acquire({ tenantId: f.config.tenantId, flowId: second.id }),
      null,
    );
    await f.db.query(
      "UPDATE workbench_coordinator.browser_leases SET acquired_at=clock_timestamp()-interval '2 minutes',authorization_expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1",
      [grant.id],
    );
    const expired = await f.c.expireLeases();
    assert.equal(expired.length, 1);
    assert.equal(expired[0]!.capacityReleased, false);
    const stats = await f.c.stats(f.config.quotaDomainId);
    assert.equal(stats.chargedBrowsers, 1);
    assert.equal(stats.quarantinedLeases, 1);
    assert.equal(stats.queuedFlows, 1);
    await assert.rejects(f.c.renew(grant), /no longer authorizes/);
    assert.equal(
      await f.c.acquire({ tenantId: f.config.tenantId, flowId: second.id }),
      null,
    );
    await f.c.confirmStopped(grant, {
      kind: "never_dispatched",
      evidenceDigest: hex("not-sent"),
      localSequence: 1,
      coversLifecycleSequence: 0,
    });
    await f.c.release(grant, { disposition: "preserved" });
    assert.ok(
      await f.c.acquire({ tenantId: f.config.tenantId, flowId: second.id }),
    );
  } finally {
    await f.c.close();
  }
});
test("an unknown start cannot be bypassed by a premature not-running observation", async () => {
  const f = await fixture(1);
  try {
    const flow = await f.submit(),
      g = (await f.c.acquire({
        tenantId: f.config.tenantId,
        flowId: flow.id,
      }))!;
    const start = await f.c.beginOperation(g, {
      kind: "start",
      requestDigest: hex("start"),
      deadlineAt: new Date(Date.now() + 5000).toISOString(),
    });
    await f.c.markDispatched(g, start.id);
    await f.c.markOperationUnknown(g, start.id);
    await assert.rejects(
      f.c.beginOperation(g, {
        kind: "stop",
        requestDigest: hex("stop"),
        deadlineAt: new Date(Date.now() + 5000).toISOString(),
      }),
      /unresolved/,
    );
    await assert.rejects(
      f.c.confirmStopped(g, {
        kind: "drained_and_stopped",
        evidenceDigest: hex("wrong"),
        localSequence: 1,
        coversLifecycleSequence: start.sequence,
      }),
      /delayed lifecycle/,
    );
    await assert.rejects(
      f.c.confirmStopped(g, {
        kind: "never_dispatched",
        evidenceDigest: hex("wrong"),
        localSequence: 1,
        coversLifecycleSequence: start.sequence,
      }),
      /may have reached/,
    );
    await assert.rejects(
      f.c.release(g, { disposition: "preserved" }),
      /Stop proof/,
    );
    await f.c.resolveOperation(g, start.id, { state: "succeeded" });
    await f.stop(g);
    await f.c.release(g, { disposition: "preserved" });
    assert.equal(
      (await f.c.leaseForFlow(f.config.tenantId, flow.id))!.released,
      true,
    );
  } finally {
    await f.c.close();
  }
});
test("atomic anonymous adoption and competing verified binds select one persistent profile", async () => {
  const f = await fixture();
  try {
    const a = await f.submit(),
      b = await f.submit();
    const ga = (await f.c.acquire({
        tenantId: f.config.tenantId,
        flowId: a.id,
      }))!,
      gb = (await f.c.acquire({ tenantId: f.config.tenantId, flowId: b.id }))!;
    const receipt = (nonce: string) => ({
      issuer: "owned",
      subjectKey: hex("account"),
      hmacKeyVersion: 1,
      nonceDigest: hex(nonce),
      assertionDigest: hex(`receipt:${nonce}`),
      verifiedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const ra = receipt("first"),
      winner = await f.c.bindIdentity(ga, ra);
    assert.equal(winner.state, "adopted");
    assert.equal(winner.profileId, a.profileId);
    assert.deepEqual(await f.c.bindIdentity(ga, ra), winner);
    const losing = await f.c.bindIdentity(gb, receipt("second"));
    assert.equal(losing.state, "switch_pending");
    assert.equal(losing.profileId, a.profileId);
    await assert.rejects(f.c.bindIdentity(gb, ra), /consumed/);
    const oldGrant = await f.c.leaseForFlow(f.config.tenantId, a.id);
    assert.equal(oldGrant!.identityId, winner.identityId);
    await f.stop(gb);
    await f.c.release(gb, { disposition: "preserved" });
    const switched = await f.c.createWarmAttachment(
      f.config.tenantId,
      b.id,
      losing.operationId,
    );
    assert.equal(switched.profileId, a.profileId);
    assert.notEqual(switched.attachmentId, b.attachmentId);
    assert.equal(
      await f.c.acquire({ tenantId: f.config.tenantId, flowId: b.id }),
      null,
    );
    await f.stop(ga);
    await f.c.release(ga, { disposition: "preserved" });
    const warm = (await f.c.acquire({
      tenantId: f.config.tenantId,
      flowId: b.id,
    }))!;
    assert.equal(warm.profileId, a.profileId);
    assert.equal(warm.epoch, 2);
    const oldEpisodes = await f.db.query<{ n: number }>(
      "SELECT count(*)::integer AS n FROM workbench_coordinator.flow_session_attachments WHERE tenant_id=$1 AND flow_id=$2",
      [f.config.tenantId, b.id],
    );
    assert.equal(oldEpisodes.rows[0]!.n, 2);
  } finally {
    await f.c.close();
  }
});
test("node restart retains old leases and unknown operations rather than reclaiming them", async () => {
  const f = await fixture(1);
  try {
    const a = await f.submit(),
      g = (await f.c.acquire({ tenantId: f.config.tenantId, flowId: a.id }))!;
    const op = await f.c.beginOperation(g, {
      kind: "create",
      requestDigest: hex("create"),
      deadlineAt: new Date(Date.now() + 5000).toISOString(),
    });
    await f.c.markDispatched(g, op.id);
    const incarnation = randomUUID();
    const registration = await f.c.ensureWorkspace({
      ...f.config,
      nodeIncarnationId: incarnation,
    });
    assert.equal(registration.nodeReady, false);
    await assert.rejects(
      f.c.markNodeReady(f.config.tenantId, f.config.nodeId, incarnation),
      /reconciliation/,
    );
    assert.equal((await f.c.listPendingOperations(g)).length, 1);
    await assert.rejects(f.c.renew(g), /no longer authorizes/);
    const another = await f.submit();
    assert.equal(
      await f.c.acquire({ tenantId: f.config.tenantId, flowId: another.id }),
      null,
    );
  } finally {
    await f.c.close();
  }
});
test("verified archive publication is fenced and capacity can free before profile ownership", async () => {
  const f = await fixture(1);
  try {
    const a = await f.submit(),
      g = (await f.c.acquire({ tenantId: f.config.tenantId, flowId: a.id }))!;
    await f.op(g, "create");
    await f.c.recordProfileCreated(g, randomUUID());
    await f.op(g, "start");
    await f.stop(g);
    assert.equal(
      (await f.c.leaseForFlow(f.config.tenantId, a.id))!.capacityReleased,
      true,
    );
    await assert.rejects(
      f.c.release(g, { disposition: "saved" }),
      /No verified/,
    );
    const other = await f.submit();
    assert.ok(
      await f.c.acquire({ tenantId: f.config.tenantId, flowId: other.id }),
    );
    const exported = await f.op(g, "export");
    const staged = await f.c.stageSnapshot(g, {
      exportOperationId: exported.id,
      objectKey: "archives/immutable-1",
      sha256: hex("bytes"),
      bytes: 10,
      engineVersion: "5.3",
      kernelVersion: "test",
    });
    const saved = await f.c.publishSnapshot(g, staged.id);
    assert.equal(saved.state, "published");
    assert.equal(
      (await f.c.getProfile(f.config.tenantId, a.profileId)).snapshot!.sha256,
      hex("bytes"),
    );
    await f.c.release(g, { disposition: "saved" });
    await assert.rejects(f.c.publishSnapshot(g, staged.id), /released/);
  } finally {
    await f.c.close();
  }
});
test("flow checkpoints survive coordinator replacement and UI metadata does not break their CAS", async () => {
  const f = await fixture(1);
  try {
    const a = await f.submit(),
      g = (await f.c.acquire({ tenantId: f.config.tenantId, flowId: a.id }))!;
    const v = await f.c.checkpoint(
      f.config.tenantId,
      a.id,
      {
        version: 1,
        stepId: "fill",
        visits: { fill: 1 },
        budgets: { actions: 1 },
      },
      0,
      g,
    );
    assert.equal(v, 1);
    await f.c.updateMetadata(f.config.tenantId, a.id, {
      visibleStatus: "running",
    });
    const replacement = new DurableCoordinator({ db: f.db });
    const record = await replacement.readFlowData(f.config.tenantId, a.id);
    assert.equal(record.checkpoint.stepId, "fill");
    assert.equal(record.revision, 1);
    await assert.rejects(
      replacement.checkpoint(
        f.config.tenantId,
        a.id,
        { stepId: "submit" },
        0,
        g,
      ),
      /changed/,
    );
    await replacement.checkpoint(
      f.config.tenantId,
      a.id,
      { stepId: "submit" },
      1,
      g,
    );
  } finally {
    await f.c.close();
  }
});
test("grounded action journal rejects stale observations and retains unknown business effects", async () => {
  const f = await fixture(1);
  try {
    const a = await f.submit(),
      g = (await f.c.acquire({ tenantId: f.config.tenantId, flowId: a.id }))!;
    await f.c.recordObservation(g, {
      sequence: 1,
      documentEpoch: 1,
      targetKey: "tab",
      frameKey: "main",
    });
    await f.c.recordObservation(g, {
      sequence: 2,
      documentEpoch: 2,
      targetKey: "tab",
      frameKey: "main",
    });
    await assert.rejects(
      f.c.journalAction(g, {
        sequence: 1,
        documentEpoch: 1,
        observationSeq: 1,
        targetKey: "tab",
        frameKey: "main",
        kind: "click",
        intentDigest: hex("click"),
      }),
      /stale/,
    );
    const action = await f.c.journalAction(g, {
      sequence: 1,
      documentEpoch: 2,
      observationSeq: 2,
      targetKey: "tab",
      frameKey: "main",
      kind: "click",
      intentDigest: hex("click"),
      effect: { scope: "order", key: "order-1" },
    });
    await f.c.markActionDispatched(g, action.id);
    await f.c.resolveAction(g, action.id, { state: "unknown" });
    await f.stop(g);
    await assert.rejects(
      f.c.release(g, { disposition: "preserved" }),
      /needs reconciliation/,
    );
    await f.c.resolveAction(g, action.id, {
      state: "reconciled",
      effectOutcome: "confirmed",
    });
    await f.c.release(g, { disposition: "preserved" });
  } finally {
    await f.c.close();
  }
});
test("tombstone prevents late archive publication and verified binding resurrection", async () => {
  const f = await fixture();
  try {
    const a = await f.submit(),
      g = (await f.c.acquire({ tenantId: f.config.tenantId, flowId: a.id }))!;
    const bound = await f.c.bindIdentity(g, {
      issuer: "owned",
      subjectKey: hex("account"),
      hmacKeyVersion: 1,
      nonceDigest: hex("nonce"),
      assertionDigest: hex("assertion"),
      verifiedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await f.stop(g);
    const op = await f.op(g, "export");
    const staged = await f.c.stageSnapshot(g, {
      exportOperationId: op.id,
      objectKey: "archive",
      sha256: hex("bytes"),
      bytes: 10,
      engineVersion: "test",
      kernelVersion: "test",
    });
    await f.c.tombstoneIdentity(f.config.tenantId, bound.identityId);
    await assert.rejects(f.c.publishSnapshot(g, staged.id), /retired/);
  } finally {
    await f.c.close();
  }
});
test("retained unknown effects transfer only to the same flow after stop, without losing the journal", async () => {
  const f = await fixture(1);
  try {
    const flow = await f.submit(),
      g = (await f.c.acquire({
        tenantId: f.config.tenantId,
        flowId: flow.id,
      }))!;
    await f.c.checkpoint(
      f.config.tenantId,
      flow.id,
      { stepId: "submit", pending: { id: "effect-1", phase: "uncertain" } },
      0,
      g,
    );
    await f.c.recordObservation(g, {
      sequence: 1,
      documentEpoch: 1,
      targetKey: "tab",
      frameKey: "main",
    });
    const action = await f.c.journalAction(g, {
      sequence: 1,
      documentEpoch: 1,
      observationSeq: 1,
      targetKey: "tab",
      frameKey: "main",
      kind: "submit",
      intentDigest: hex("submit"),
      effect: { scope: "save", key: "item" },
    });
    await f.c.markActionDispatched(g, action.id);
    await f.c.resolveAction(g, action.id, { state: "unknown" });
    const incarnation = randomUUID();
    await f.c.ensureWorkspace({ ...f.config, nodeIncarnationId: incarnation });
    await assert.rejects(
      f.c.resumeRetainedFlow(f.config.tenantId, flow.id, incarnation),
      /proven stopped/,
    );
    await f.stop(g);
    await assert.rejects(
      f.c.release(g, { disposition: "preserved" }),
      /needs reconciliation/,
    );
    const resumed = (await f.c.resumeRetainedFlow(
      f.config.tenantId,
      flow.id,
      incarnation,
    ))!;
    assert.equal(resumed.profileId, g.profileId);
    assert.equal(resumed.epoch, g.epoch + 1);
    assert.notEqual(resumed.id, g.id);
    assert.deepEqual(
      (await f.c.readFlowData(f.config.tenantId, flow.id)).checkpoint.pending,
      { id: "effect-1", phase: "uncertain" },
    );
    await assert.rejects(f.c.renew(g), /released/);
    await f.c.resolveAction(resumed, action.id, {
      state: "reconciled",
      effectOutcome: "confirmed",
    });
    await f.c.checkpoint(
      f.config.tenantId,
      flow.id,
      { stepId: "receipt_confirmed" },
      1,
      resumed,
    );
    await f.stop(resumed);
    await f.c.release(resumed, { disposition: "preserved" });
  } finally {
    await f.c.close();
  }
});
test("observed proxy exit ownership is global and retained until browser stop", async () => {
  const f = await fixture();
  try {
    const a = await f.submit(),
      b = await f.submit(),
      ga = (await f.c.acquire({ tenantId: f.config.tenantId, flowId: a.id }))!,
      gb = (await f.c.acquire({ tenantId: f.config.tenantId, flowId: b.id }))!;
    assert.equal(
      await f.c.claimProxyExit(ga, "192.0.2.30", { provider: "fixture" }),
      true,
    );
    assert.equal(await f.c.claimProxyExit(gb, "::ffff:192.0.2.30"), false);
    await assert.rejects(f.c.releaseProxyExit(ga), /stop is proven/);
    await f.stop(ga);
    await f.c.releaseProxyExit(ga);
    assert.equal(await f.c.claimProxyExit(gb, "192.0.2.30"), true);
  } finally {
    await f.c.close();
  }
});
test("definite rejected creation releases its reservation without claiming the request was never sent", async () => {
  const f = await fixture(1);
  try {
    const flow = await f.submit(),
      g = (await f.c.acquire({
        tenantId: f.config.tenantId,
        flowId: flow.id,
      }))!;
    const op = await f.c.beginOperation(g, {
      kind: "create",
      requestDigest: hex("create"),
      deadlineAt: new Date(Date.now() + 5000).toISOString(),
    });
    await f.c.markDispatched(g, op.id);
    await f.c.resolveOperation(g, op.id, {
      outcome: "rejected",
      vendorErrorCode: "rate_limit_exceeded",
    });
    await assert.rejects(
      f.c.confirmStopped(g, {
        kind: "never_dispatched",
        evidenceDigest: hex("wrong"),
        localSequence: 1,
        coversLifecycleSequence: 1,
      }),
      /may have reached/,
    );
    await f.c.confirmStopped(g, {
      kind: "no_browser_started",
      evidenceDigest: hex("rejected"),
      localSequence: 1,
      coversLifecycleSequence: 1,
    });
    await f.c.release(g, { disposition: "preserved" });
    assert.equal(
      (await f.c.leaseForFlow(f.config.tenantId, flow.id))!.released,
      true,
    );
  } finally {
    await f.c.close();
  }
});
test("fair queue bypasses a retired candidate instead of blocking every healthy flow", async () => {
  const f = await fixture(1);
  try {
    const retired = await f.submit(),
      healthy = await f.submit();
    await f.c.retireAnonymousProfile(f.config.tenantId, retired.profileId);
    assert.equal(
      await f.c.acquire({ tenantId: f.config.tenantId, flowId: retired.id }),
      null,
    );
    assert.ok(
      await f.c.acquire({ tenantId: f.config.tenantId, flowId: healthy.id }),
    );
  } finally {
    await f.c.close();
  }
});
test("retained resumption cannot clear administrative identity, profile or node quarantine", async () => {
  const f = await fixture(1);
  try {
    const flow = await f.submit(),
      g = (await f.c.acquire({
        tenantId: f.config.tenantId,
        flowId: flow.id,
      }))!;
    const identity = await f.c.bindIdentity(g, {
      issuer: "owned",
      subjectKey: hex("owner"),
      hmacKeyVersion: 1,
      nonceDigest: hex("n"),
      assertionDigest: hex("a"),
      verifiedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await f.stop(g);
    await f.db.query(
      "UPDATE workbench_coordinator.identities SET state='quarantined' WHERE tenant_id=$1 AND id=$2",
      [f.config.tenantId, identity.identityId],
    );
    await assert.rejects(
      f.c.resumeRetainedFlow(
        f.config.tenantId,
        flow.id,
        f.config.nodeIncarnationId,
      ),
      /Identity is unavailable/,
    );
    await f.db.query(
      "UPDATE workbench_coordinator.identities SET state='ready' WHERE tenant_id=$1 AND id=$2",
      [f.config.tenantId, identity.identityId],
    );
    await f.db.query(
      "UPDATE workbench_coordinator.logical_profiles SET state='quarantined' WHERE tenant_id=$1 AND id=$2",
      [f.config.tenantId, flow.profileId],
    );
    await assert.rejects(
      f.c.resumeRetainedFlow(
        f.config.tenantId,
        flow.id,
        f.config.nodeIncarnationId,
      ),
      /Profile is unavailable/,
    );
    await f.db.query(
      "UPDATE workbench_coordinator.logical_profiles SET state='ready' WHERE tenant_id=$1 AND id=$2",
      [f.config.tenantId, flow.profileId],
    );
    await f.db.query(
      "UPDATE workbench_coordinator.engine_nodes SET state='draining' WHERE tenant_id=$1 AND id=$2",
      [f.config.tenantId, f.config.nodeId],
    );
    await assert.rejects(
      f.c.resumeRetainedFlow(
        f.config.tenantId,
        flow.id,
        f.config.nodeIncarnationId,
      ),
      /administratively unavailable/,
    );
  } finally {
    await f.c.close();
  }
});
test("profile metadata merges under live ownership and rejects writes after identity tombstone", async () => {
  const f = await fixture(1);
  try {
    const flow = await f.submit(),
      g = (await f.c.acquire({
        tenantId: f.config.tenantId,
        flowId: flow.id,
      }))!;
    await f.c.setProfileMetadata(g, { proxyVault: true });
    await f.c.setProfileMetadata(g, { policy: "stable" });
    assert.deepEqual(
      (await f.c.getProfile(f.config.tenantId, flow.profileId)).metadata,
      { proxyVault: true, policy: "stable" },
    );
    const bound = await f.c.bindIdentity(g, {
      issuer: "owned",
      subjectKey: hex("metadata-owner"),
      hmacKeyVersion: 1,
      nonceDigest: hex("metadata-nonce"),
      assertionDigest: hex("metadata-receipt"),
      verifiedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await f.c.tombstoneIdentity(f.config.tenantId, bound.identityId);
    await assert.rejects(
      f.c.setProfileMetadata(g, { proxyVault: false }),
      /no longer authorizes/,
    );
    assert.equal(
      (await f.c.getProfile(f.config.tenantId, flow.profileId)).metadata
        .proxyVault,
      true,
    );
  } finally {
    await f.c.close();
  }
});
test(
  "two real PostgreSQL clients serialize final-slot admission and reject a second node owner",
  { skip: !process.env.COORDINATOR_TEST_DATABASE_URL },
  async () => {
    const db1 = new PgDatabase(process.env.COORDINATOR_TEST_DATABASE_URL!),
      db2 = new PgDatabase(process.env.COORDINATOR_TEST_DATABASE_URL!);
    const c1 = new DurableCoordinator({ db: db1 }),
      c2 = new DurableCoordinator({ db: db2 });
    try {
      await c1.migrate();
      const base: WorkspaceConfig = {
        tenantId: randomUUID(),
        siteId: randomUUID(),
        quotaDomainId: randomUUID(),
        vendorTeamKey: randomUUID(),
        nodeId: randomUUID(),
        nodeIncarnationId: randomUUID(),
        engineProcessKey: randomUUID(),
        origin: "https://owned-real-pg.test",
        totalBrowserBudget: 1,
      };
      const node2 = {
        ...base,
        nodeId: randomUUID(),
        nodeIncarnationId: randomUUID(),
        engineProcessKey: randomUUID(),
      };
      await c1.ensureWorkspace(base);
      await c2.ensureWorkspace(node2);
      const unlock = await db1.holdNodeLock(base.nodeId, () => {});
      try {
        await assert.rejects(
          db2.holdNodeLock(base.nodeId, () => {}),
          /Another workbench/,
        );
      } finally {
        await unlock();
      }
      const submit = (c: DurableCoordinator, nodeId: string) =>
        c.submitFlow({
          tenantId: base.tenantId,
          siteId: base.siteId,
          quotaDomainId: base.quotaDomainId,
          nodeId,
          requestId: randomUUID(),
          pack: {
            key: "owned",
            version: "1",
            hash: hex("pack"),
            artifactKey: "owned.json",
          },
          deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        });
      const a = await submit(c1, base.nodeId),
        b = await submit(c2, node2.nodeId);
      const grants = await Promise.all([
        c1.acquire({ tenantId: base.tenantId, flowId: a.id }),
        c2.acquire({ tenantId: base.tenantId, flowId: b.id }),
      ]);
      assert.equal(grants.filter(Boolean).length, 1);
      const g = grants.find(Boolean)!;
      await c1.confirmStopped(g, {
        kind: "never_dispatched",
        evidenceDigest: hex("no-engine-call"),
        localSequence: 1,
        coversLifecycleSequence: 0,
      });
      await c1.release(g, { disposition: "preserved" });
    } finally {
      await c1.close();
      await c2.close();
    }
  },
);
