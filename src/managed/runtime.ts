import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, open } from "node:fs/promises";
import { join, posix, resolve, win32 } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  DurableCoordinator,
  PgDatabase,
  type FlowRecord,
  type LeaseGrant,
  type OperationKind,
} from "../coordinator/index.js";
import { compileFlow } from "../flows/compiler.js";
import { createPuppeteerFlowDriver } from "../flows/driver.js";
import { runFlow } from "../flows/interpreter.js";
import type {
  CompiledFlow,
  FlowEvent,
  FlowManifest,
  FlowPack,
  FlowSnapshot,
  IdentityResolver,
} from "../flows/types.js";
import { KameleoEngine, type EngineAdapter } from "../engine.js";
import {
  RuntimeError,
  type RunRecord,
  type RuntimeProxies,
} from "../runtime.js";
import type { PacePreset } from "../actions.js";
import type { JsonSchema } from "../automation.js";
import type { FlowPolicies } from "./policies.js";
import type {
  ProxyRequest,
  KameleoProxyChoice,
  ProxyReport,
} from "../proxies/types.js";
import {
  bounded,
  digest,
  durableWrite,
  InputVault,
  stableId,
} from "./storage.js";

export interface ManagedOptions {
  databaseUrl: string;
  tenantId: string;
  nodeId: string;
  teamKey: string;
  browserBudget: number;
  engineUrl: string;
  dataDir: string;
  flowsDir: string;
  localExportDir: string;
  engineExportDir: string;
  maxConcurrency: number;
  runTimeoutMs: number;
  idleTimeoutMs: number;
  policies: FlowPolicies;
  fixtureOrigin?: string;
  proxies?: RuntimeProxies;
  engine?: EngineAdapter;
  database?: PgDatabase;
}
interface Session {
  grant: LeaseGrant;
  abort: AbortController;
  browser?: Browser;
  page?: Page;
  deadline: number;
  sequence: number;
  stopped: boolean;
  uncertain: boolean;
  lastProgress: number;
  heartbeat?: NodeJS.Timeout;
  timeout?: NodeJS.Timeout;
  input?: {
    id: string;
    validate: (value: unknown) => boolean;
    resolve: (v: Record<string, unknown>) => void;
    reject: (e: Error) => void;
  };
  resume?: () => void;
  finish?: () => void;
  proxyLeaseId?: string;
  switchOperationId?: string;
  providerBackoff?: boolean;
}
const validator = new Ajv2020({ strict: false, allErrors: false });

export class ManagedRuntime extends EventEmitter {
  readonly coordinator: DurableCoordinator;
  private db: PgDatabase;
  private engine: EngineAdapter;
  private vault: InputVault;
  private packs = new Map<string, CompiledFlow>();
  private records = new Map<
    string,
    RunRecord & {
      flowState?: string;
      stepId?: string;
      identityId?: string;
      waitReason?: string;
    }
  >();
  private sessions = new Map<string, Session>();
  private work = new Map<string, Promise<void>>();
  private incarnation = randomUUID();
  private quotaId: string;
  private closed = false;
  private ticking = false;
  private timer?: NodeJS.Timeout;
  private unlock?: () => Promise<void>;
  private agentSequence = 0;
  private journalWrite = Promise.resolve();
  private purgedInputs = new Set<string>();
  constructor(private options: ManagedOptions) {
    super();
    this.db =
      options.database ??
      new PgDatabase({
        connectionString: options.databaseUrl,
        connectionTimeoutMillis: 5000,
        statement_timeout: 5000,
        query_timeout: 6000,
        max: 12,
      });
    this.coordinator = new DurableCoordinator({ db: this.db });
    this.engine = options.engine ?? new KameleoEngine(options.engineUrl);
    this.vault = new InputVault(join(options.dataDir, "inputs"));
    this.quotaId = stableId(`kameleo-team:${options.teamKey}`);
  }
  async init() {
    await Promise.all([
      this.vault.init(),
      mkdir(this.options.flowsDir, { recursive: true }),
      mkdir(this.options.localExportDir, { recursive: true }),
      mkdir(join(this.options.dataDir, "packs"), { recursive: true }),
    ]);
    await this.coordinator.migrate();
    this.unlock = await this.db.holdNodeLock(this.options.nodeId, () => {
      this.closed = true;
      for (const session of this.sessions.values())
        session.abort.abort(new Error("Node ownership lost"));
    });
    try {
      this.agentSequence = Number(
        await readFile(join(this.options.dataDir, "agent-sequence"), "utf8"),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!Number.isSafeInteger(this.agentSequence) || this.agentSequence < 0)
      throw new Error("Invalid node journal sequence");
    for (const name of await readdir(this.options.flowsDir)) {
      if (!name.endsWith(".flow.json")) continue;
      const pack = JSON.parse(
        await readFile(join(this.options.flowsDir, name), "utf8"),
      ) as FlowPack;
      const manifest = JSON.parse(
        await readFile(
          join(
            this.options.flowsDir,
            name.replace(".flow.json", ".manifest.json"),
          ),
          "utf8",
        ),
      ) as FlowManifest;
      if (this.options.fixtureOrigin && pack.id === "owned-account-signin")
        manifest.origins.owned = this.options.fixtureOrigin;
      const compiled = compileFlow(pack, manifest);
      if (
        !this.options.policies.profiles[pack.execution.profilePolicyId] ||
        !this.options.policies.proxies[pack.execution.proxyPolicyId]
      )
        throw new Error(`Missing execution policy for ${pack.id}`);
      if (this.packs.has(pack.id))
        throw new Error(`Duplicate flow ID ${pack.id}`);
      this.packs.set(pack.id, compiled);
      await durableWrite(
        join(this.options.dataDir, "packs", `${compiled.hash}.json`),
        JSON.stringify({ pack, manifest }),
      );
      const origin = manifest.origins[pack.start.originRef]!;
      await this.coordinator.ensureWorkspace({
        tenantId: this.options.tenantId,
        siteId: stableId(`site:${this.options.tenantId}:${origin}`),
        origin,
        quotaDomainId: this.quotaId,
        vendorTeamKey: this.options.teamKey,
        totalBrowserBudget: this.options.browserBudget,
        nodeId: this.options.nodeId,
        nodeIncarnationId: this.incarnation,
        engineProcessKey: this.incarnation,
        nodeMaxBrowsers: this.options.maxConcurrency,
      });
    }
    if (!this.packs.size) throw new Error("No .flow.json packs found");
    await this.recover();
    await this.refresh();
    this.timer = setInterval(() => {
      void this.tick().catch(() => {});
    }, 1500);
    this.timer.unref();
  }
  listAutomations() {
    return [...this.packs.values()].map(({ pack }) => ({
      id: pack.id,
      title: pack.title,
      description: `Flow ${pack.version}`,
      inputSchema: pack.inputSchema,
    }));
  }
  list() {
    return [...this.records.values()]
      .map((x) => structuredClone(x))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  get(id: string) {
    const value = this.records.get(id);
    if (!value) throw new RuntimeError("Run not found", 404);
    return structuredClone(value);
  }
  async submit(request: {
    automationId: string;
    inputs: Record<string, unknown>;
    preset?: PacePreset;
    identityId?: string;
  }) {
    if (this.closed) throw new RuntimeError("Runtime is closing");
    const compiled = this.packs.get(request.automationId);
    if (!compiled || !compiled.validateInputs(request.inputs))
      throw new RuntimeError("Unknown flow or invalid inputs", 400);
    const id = randomUUID(),
      origin = compiled.manifest.origins[compiled.pack.start.originRef]!;
    await this.vault.put(id, request.inputs);
    try {
      const flow = await this.coordinator.submitFlow({
        flowId: id,
        requestId: id,
        tenantId: this.options.tenantId,
        siteId: stableId(`site:${this.options.tenantId}:${origin}`),
        quotaDomainId: this.quotaId,
        nodeId: this.options.nodeId,
        pack: {
          key: compiled.pack.id,
          version: compiled.pack.version,
          hash: compiled.hash,
          artifactKey: `${compiled.hash}.json`,
        },
        deadlineAt: new Date(
          Date.now() +
            Math.min(
              this.options.runTimeoutMs,
              compiled.pack.limits.maxTotalMs,
            ),
        ).toISOString(),
        identityId: request.identityId,
        metadata: {
          automationId: compiled.pack.id,
          preset: request.preset ?? "fast",
          timings: { submittedAt: Date.now() },
        },
      });
      this.cache(flow);
      void this.tick().catch(() => {});
      return this.get(id);
    } catch (error) {
      await this.vault.delete(id);
      throw error;
    }
  }
  private cache(flow: FlowRecord) {
    const existing = this.records.get(flow.id);
    const record = {
      id: flow.id,
      managed: true,
      automationId: flow.pack.key,
      state: (flow.waitReason === "switch_pending" && this.work.has(flow.id)
        ? "starting"
        : flow.state === "preparing"
        ? "starting"
        : flow.state === "recovering" || flow.state === "review"
          ? "interrupted"
          : flow.state) as RunRecord["state"],
      createdAt: flow.createdAt,
      updatedAt: flow.updatedAt,
      logs: existing?.logs ?? [],
      timings: (flow.metadata.timings as Record<string, number>) ?? {},
      preset: (flow.metadata.preset as PacePreset) ?? "fast",
      profileId: flow.kameleoProfileId,
      identityId: flow.identityId,
      waitReason: flow.waitReason,
      artifact: flow.metadata.artifact as RunRecord["artifact"],
      cleanupRequired: flow.state === "recovering",
      ...(existing?.challenge ? { challenge: existing.challenge } : {}),
      pauseRequested: existing?.pauseRequested,
      waitingForFinish: existing?.waitingForFinish,
      flowState: existing?.flowState ?? (flow.checkpoint as unknown as FlowSnapshot).lastEvent?.stateId,
      stepId: existing?.stepId ?? (flow.checkpoint as unknown as FlowSnapshot).stepId,
    };
    this.records.set(flow.id, record);
    this.emit("run", structuredClone(record));
  }
  private async refresh() {
    for (const flow of await this.coordinator.listFlows(this.options.tenantId, {
      nodeId: this.options.nodeId,
    })) {
      this.cache(flow);
      if (!this.sessions.has(flow.id) && !this.work.has(flow.id) && !this.purgedInputs.has(flow.id) && Date.parse(flow.deadlineAt) <= Date.now()) {
        await this.vault.delete(flow.id); this.purgedInputs.add(flow.id);
      }
    }
  }
  private async status(id: string, state: string, reason?: string) {
    await this.coordinator.setFlowStatus(
      this.options.tenantId,
      id,
      state,
      reason,
    );
    this.cache(await this.coordinator.getFlow(this.options.tenantId, id));
  }
  private async tick() {
    if (this.closed || this.ticking) return;
    this.ticking = true;
    try {
      await this.coordinator.expireLeases();
      await this.refresh();
      for (const record of this.list().reverse()) {
        if (this.work.size >= this.options.maxConcurrency) break;
        if (record.state !== "queued" || this.work.has(record.id)) continue;
        const sent = performance.now();
        const grant = await this.coordinator.acquire({
          tenantId: this.options.tenantId,
          flowId: record.id,
          ttlMs: 45_000,
        });
        if (!grant || grant.state !== "held") continue;
        const task = this.execute(record.id, grant, sent + 40_000).finally(() =>
          this.work.delete(record.id),
        );
        this.work.set(record.id, task);
        void task.catch(() => {});
      }
    } finally {
      this.ticking = false;
    }
  }
  private async guard(id: string) {
    const session = this.sessions.get(id);
    if (!session) throw new Error("No active lease");
    session.abort.signal.throwIfAborted();
    if (this.closed || performance.now() >= session.deadline)
      throw new Error("Lease authorization expired");
    const record = this.records.get(id)!;
    if (record.pauseRequested) {
      const waiting = new Promise<void>((r) => {
        session.resume = r;
      });
      await this.status(id, "paused");
      await bounded(waiting, this.options.idleTimeoutMs, session.abort.signal);
    }
    session.abort.signal.throwIfAborted();
    if (performance.now() >= session.deadline)
      throw new Error("Lease authorization expired");
  }
  private async operation<T>(
    session: Session,
    kind: OperationKind,
    run: () => Promise<T>,
    timeoutMs = 30_000,
  ): Promise<{ value: T; operationId: string }> {
    const op = await this.coordinator.beginOperation(session.grant, {
      kind,
      requestDigest: digest(`${session.grant.id}:${kind}:${randomUUID()}`),
      deadlineAt: new Date(Date.now() + timeoutMs).toISOString(),
      recoveryTag: `run-${session.grant.flowId}`,
    });
    session.sequence = op.sequence;
    if (kind === "create" || kind === "start" || kind === "attach") {
      try {
        const reservation = await this.coordinator.reserveRequest(
          session.grant,
          kind === "create" ? "CreateProfile" : "StartProfile",
          op.id,
        );
        await delay(
          Math.max(0, Date.parse(reservation.notBefore) - Date.now()),
          undefined,
          { signal: session.abort.signal },
        );
        if (performance.now() >= session.deadline)
          throw new Error("Lease expired before provider dispatch");
        await this.coordinator.markRequestDispatched(
          session.grant,
          reservation.id,
        );
      } catch (error) {
        await this.coordinator.resolveOperation(session.grant, op.id, {
          state: "cancelled_before_dispatch",
        });
        throw error;
      }
    }
    await this.coordinator.markDispatched(session.grant, op.id);
    let settled = false;
    const promise = run().then(
      async (value) => {
        settled = true;
        await this.coordinator.resolveOperation(session.grant, op.id, {
          outcome: "succeeded",
        });
        return value;
      },
      async (error) => {
        settled = true;
        const failure = error as {
          status?: number;
          errorCode?: string;
          response?: Response;
        };
        const status = Number(failure.response?.status ?? failure.status);
        let code = failure.errorCode;
        if (!code && failure.response)
          code = (
            (await failure.response
              .clone()
              .json()
              .catch(() => ({}))) as { errorCode?: string }
          ).errorCode;
        const capacity = [
          "running_profiles_limit_reached",
          "running_mobile_profiles_limit_reached",
          "rate_limit_exceeded",
        ].includes(code ?? "");
        if (capacity || [400, 401, 402, 403, 404, 422, 429].includes(status)) {
          await this.coordinator.resolveOperation(session.grant, op.id, {
            outcome: "rejected",
            vendorErrorCode: /^[a-z_]{1,80}$/.test(code ?? "")
              ? code
              : `http_${status}`,
          });
          if (capacity || status === 429) {
            session.providerBackoff = true;
            await this.coordinator.providerBackoff(
              session.grant.quotaDomainId,
              3000 + Math.floor(Math.random() * 2000),
            );
          }
        } else {
          session.uncertain = true;
          await this.coordinator.markOperationUnknown(session.grant, op.id);
        }
        throw error;
      },
    );
    try {
      return {
        value: await bounded(
          promise,
          timeoutMs,
          kind === "stop" || kind === "export"
            ? undefined
            : session.abort.signal,
        ),
        operationId: op.id,
      };
    } catch (error) {
      if (!settled) {
        session.uncertain = true;
        await this.coordinator
          .markOperationUnknown(session.grant, op.id)
          .catch(() => {});
      }
      throw error;
    }
  }
  private async execute(
    id: string,
    grant: LeaseGrant,
    authorizationDeadline: number,
  ) {
    const session: Session = {
      grant,
      abort: new AbortController(),
      deadline: authorizationDeadline,
      sequence: 0,
      stopped: false,
      uncertain: false,
      lastProgress: performance.now(),
    };
    this.sessions.set(id, session);
    let renewing = false;
    session.heartbeat = setInterval(() => {
      if (renewing || session.stopped) return;
      renewing = true;
      const sent = performance.now();
      void bounded(this.coordinator.renew(session.grant, 45_000), 5000)
        .then(
          (g) => {
            session.grant = g;
            session.deadline = sent + 40_000;
          },
          () => session.abort.abort(new Error("Lease renewal failed")),
        )
        .finally(() => {
          renewing = false;
        });
      if (performance.now() - session.lastProgress > this.options.idleTimeoutMs)
        session.abort.abort(new Error("Session idle limit exceeded"));
    }, 10_000);
    try {
      const flow = await this.coordinator.getFlow(this.options.tenantId, id);
      const { pack, manifest } = JSON.parse(
        await readFile(
          join(this.options.dataDir, "packs", flow.pack.artifactKey),
          "utf8",
        ),
      ) as { pack: FlowPack; manifest: FlowManifest };
      const compiled = compileFlow(pack, manifest);
      if (compiled.hash !== flow.pack.hash)
        throw new Error("Flow pack changed");
      const inputs = await this.vault.get<Record<string, unknown>>(id);
      session.timeout = setTimeout(
        () => session.abort.abort(new Error("Flow deadline reached")),
        Math.max(1, Date.parse(flow.deadlineAt) - Date.now()),
      );
      await this.status(id, "starting");
      await bounded(this.engine.ready(), 10_000, session.abort.signal);
      if (!grant.kameleoProfileId) {
        const context = { inputs, runId: id, signal: session.abort.signal };
        const settings = await bounded(
          Promise.resolve(
            this.options.policies.profiles[pack.execution.profilePolicyId]!(
              context,
            ),
          ),
          10_000,
          session.abort.signal,
        );
        const proxy = await bounded(
          Promise.resolve(
            this.options.policies.proxies[pack.execution.proxyPolicyId]!(
              context,
            ),
          ),
          10_000,
          session.abort.signal,
        );
        if (proxy) {
          const lease = await this.options.proxies!.allocate(
            proxy,
            id,
            session.abort.signal,
          );
          session.proxyLeaseId = lease.id;
          const report = lease.report as { verified?: { exitIp?: string } };
          if (
            !report?.verified?.exitIp ||
            !(await this.coordinator.claimProxyExit(
              session.grant,
              report.verified.exitIp,
              report as Record<string, unknown>,
            ))
          )
            throw new Error("Proxy exit is already in use");
          settings.proxy = lease.proxy;
          const choice = lease.proxy as KameleoProxyChoice;
          const warmRequest: ProxyRequest = {
            ...proxy,
            provider: "direct",
            proxy: {
              protocol: choice.value,
              host: choice.extra.host,
              port: choice.extra.port,
              username: choice.extra.id,
              password: choice.extra.secret,
            },
          };
          await this.vault.put(session.grant.profileId, {
            request: warmRequest,
            expiresAt: (lease.report as ProxyReport).expiresAt,
          });
          await this.coordinator.setProfileMetadata(session.grant, {
            proxyVault: true,
          });
        }
        if (settings.storage !== undefined && settings.storage !== "local")
          throw new Error("Managed flows require local profiles");
        const created = await this.operation(session, "create", async () => {
          const profile = await this.engine.create({
            ...settings,
            storage: "local",
            name: `run-${id}`,
          });
          await this.coordinator.recordProfileCreated(
            session.grant,
            profile.id,
          );
          session.grant.kameleoProfileId = profile.id;
          return profile;
        });
        await this.coordinator.recordProfileCreated(
          session.grant,
          created.value.id,
        );
        session.grant.kameleoProfileId = created.value.id;
      } else {
        const profileState = await this.coordinator.getProfile(
          this.options.tenantId,
          grant.profileId,
        );
        if (profileState.metadata.proxyVault) {
          const stored = await this.vault.get<{
            request: ProxyRequest;
            expiresAt?: string;
          }>(grant.profileId);
          const request = stored.request;
          if (
            stored.expiresAt &&
            Date.parse(stored.expiresAt) <=
              Date.now() + (request.minRemainingMs ?? 0)
          )
            throw new Error("Stored proxy expired");
          const lease = await this.options.proxies!.allocate(
            request,
            id,
            session.abort.signal,
          );
          session.proxyLeaseId = lease.id;
          const report = lease.report as ProxyReport;
          if (
            !(await this.coordinator.claimProxyExit(
              session.grant,
              report.verified.exitIp,
              report as unknown as Record<string, unknown>,
            ))
          )
            throw new Error("Proxy exit is already in use");
        }
      }
      const profile = session.grant.kameleoProfileId!;
      await this.guard(id);
      await this.operation(
        session,
        "install",
        () => this.engine.install(profile),
        180_000,
      );
      await this.guard(id);
      await this.operation(
        session,
        "start",
        () => this.engine.start(profile),
        60_000,
      );
      const endpoint = new URL(this.options.engineUrl);
      endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
      endpoint.pathname = `/puppeteer/${profile}`;
      endpoint.search = "";
      endpoint.hash = "";
      await this.guard(id);
      session.browser = (
        await this.operation(
          session,
          "attach",
          () =>
            puppeteer.connect({
              browserWSEndpoint: endpoint.href,
              defaultViewport: null,
              protocolTimeout: 15_000,
            }),
          20_000,
        )
      ).value;
      const pages = await session.browser.pages();
      session.page =
        pages.find((page) =>
          Object.values(compiled.manifest.origins).some((origin) =>
            page.url().startsWith(`${origin}/`),
          ),
        ) ??
        pages[0] ??
        (await session.browser.newPage());
      if (
        Object.keys(flow.checkpoint).length &&
        !(flow.checkpoint as unknown as FlowSnapshot).pending &&
        ["about:blank", "chrome://newtab/", "chrome://new-tab-page/"].includes(
          session.page.url(),
        ) &&
        compiled.manifest.safeNavigationPaths?.includes(
          `${pack.start.originRef}:${pack.start.pathname}`,
        )
      ) {
        await this.guard(id);
        await session.page.goto(
          new URL(
            pack.start.pathname,
            compiled.manifest.origins[pack.start.originRef],
          ).href,
          { waitUntil: "domcontentloaded", timeout: 10_000 },
        );
      }
      await this.status(id, "running");
      let revision = flow.revision;
      const receipts = new Map<
        string,
        {
          expected: string;
          issuer: string;
          subjectKey: string;
          resolver: string;
        }
      >();
      const identities: Record<string, IdentityResolver> = {};
      for (const [name, resolver] of Object.entries(
        this.options.policies.identities,
      ))
        identities[name] = {
          bind: async (expected) => {
            await this.guard(id);
            const identity = await bounded(
              resolver(expected, {
                page: session.page!,
                runId: id,
                signal: session.abort.signal,
              }),
              10_000,
              session.abort.signal,
            );
            const result = await this.coordinator.bindIdentity(
              session.grant,
              identity,
            );
            if (result.state === "switch_pending")
              session.switchOperationId = result.operationId;
            else if (result.state !== "adopted")
              throw new RuntimeError("Identity binding could not be confirmed");
            session.grant = (await this.coordinator.leaseForFlow(
              this.options.tenantId,
              id,
            ))!;
            const receipt = randomUUID();
            receipts.set(receipt, {
              expected,
              issuer: identity.issuer,
              subjectKey: identity.subjectKey,
              resolver: name,
            });
            this.records.get(id)!.identityId = result.identityId;
            return receipt;
          },
          verify: async (receipt) => {
            const saved = receipts.get(receipt);
            if (!saved) return false;
            await this.guard(id);
            const current = await bounded(
              resolver(saved.expected, {
                page: session.page!,
                runId: id,
                signal: session.abort.signal,
              }),
              10_000,
              session.abort.signal,
            );
            return (
              current.issuer === saved.issuer &&
              current.subjectKey === saved.subjectKey &&
              Date.parse(current.expiresAt) > Date.now()
            );
          },
        };
      const driver = createPuppeteerFlowDriver(session.page, compiled, {
        preset: this.records.get(id)!.preset,
        signal: session.abort.signal,
        checkpoint: () => this.guard(id),
        seed: id,
      });
      try {
        const result = await runFlow(compiled, {
          runId: id,
          inputs,
          driver,
          signal: session.abort.signal,
          checkpoint: () => this.guard(id),
          resume: Object.keys(flow.checkpoint).length > 0,
          identityResolvers: identities,
          journal: {
            load: async () =>
              Object.keys(flow.checkpoint).length
                ? (flow.checkpoint as unknown as FlowSnapshot)
                : null,
            save: async (snapshot) => {
              revision = await this.coordinator.checkpoint(
                this.options.tenantId,
                id,
                snapshot as unknown as Record<string, unknown>,
                revision,
                session.grant,
              );
            },
          },
          requestInput: (title, fields, signal) =>
            this.ask(id, title, fields, signal),
          onEvent: (event) => this.event(id, event),
          afterAction: async (_snapshot, operation) =>
            operation.op === "bindIdentity" && session.switchOperationId
              ? "handoff"
              : "continue",
        });
        if (session.switchOperationId) {
          await this.stop(session);
          await this.coordinator.release(session.grant, {
            disposition: "preserved",
          });
          const current = await this.coordinator.readFlowData(
            this.options.tenantId,
            id,
          );
          const snapshot = current.checkpoint as unknown as FlowSnapshot;
          snapshot.status = "running";
          delete snapshot.stepId;
          delete snapshot.completionMode;
          await this.coordinator.checkpoint(this.options.tenantId, id, {
            checkpoint: snapshot as unknown as Record<string, unknown>,
            expectedRevision: current.revision,
          });
          await this.coordinator.createWarmAttachment(
            this.options.tenantId,
            id,
            session.switchOperationId,
          );
          await this.refresh();
          return;
        }
        if (result.status !== "completed")
          throw new Error("Flow handoff has no binding operation");
        if (result.mode === "await-operator-then-save")
          await this.waitForFinish(id);
        if (pack.identityPolicy === "required") {
          if (!session.grant.identityId || !receipts.size)
            throw new Error("Identity needs re-verification before export");
          for (const [receipt, saved] of receipts) {
            if (
              !(await identities[saved.resolver]!.verify(receipt, {
                runId: id,
                signal: session.abort.signal,
              }))
            )
              throw new Error("Authenticated identity changed before export");
          }
        }
      } finally {
        driver.dispose?.();
      }
      await this.save(id, session);
    } catch {
      if (this.records.get(id)?.state === "export_failed") {
        if (session.uncertain)
          await this.coordinator
            .quarantine(session.grant, "unknown_export_operation")
            .catch(() => {});
      } else if (session.uncertain)
        await this.coordinator
          .quarantine(session.grant, "unknown_engine_operation")
          .catch(() => {});
      else {
        try {
          await this.stop(session);
          await this.coordinator.release(session.grant, {
            disposition: "preserved",
          });
        } catch {
          session.uncertain = true;
          await this.coordinator
            .quarantine(session.grant, "stop_unconfirmed")
            .catch(() => {});
        }
      }
      if (
        session.providerBackoff &&
        !session.uncertain &&
        !session.abort.signal.aborted
      ) {
        const flow = await this.coordinator.getFlow(this.options.tenantId, id);
        const attempts = Number(flow.metadata.capacityRetries ?? 0) + 1;
        await this.coordinator.updateMetadata(this.options.tenantId, id, {
          capacityRetries: attempts,
        });
        if (attempts < 5 && Date.parse(flow.deadlineAt) > Date.now())
          await this.coordinator.requeueFlow(this.options.tenantId, id);
        else
          await this.status(id, "failed", "provider_capacity_retry_exhausted");
        await this.refresh();
      } else if (this.records.get(id)?.state !== "export_failed")
        await this.status(
          id,
          session.uncertain
            ? "recovering"
            : session.abort.signal.aborted
              ? "cancelled"
              : "failed",
          session.uncertain ? "stop_unconfirmed" : "flow_stopped",
        ).catch(() => {});
    } finally {
      clearInterval(session.heartbeat);
      clearTimeout(session.timeout);
      session.input?.reject(new Error("Run ended"));
      session.resume?.();
      session.finish?.();
      await session.browser?.disconnect().catch(() => {});
      if (session.stopped && session.proxyLeaseId)
        await this.options.proxies?.release(session.proxyLeaseId);
      if (
        this.records.get(id)?.state === "saved" ||
        this.records.get(id)?.state === "cancelled"
      )
        await this.vault.delete(id);
      this.sessions.delete(id);
      const record = this.records.get(id);
      if (record) {
        delete record.challenge;
        record.pauseRequested = false;
        record.waitingForFinish = false;
        this.emit("run", structuredClone(record));
      }
    }
  }
  private async stop(session: Session) {
    if (session.uncertain) throw new Error("Unresolved Engine operation");
    await session.browser?.disconnect();
    session.browser = undefined;
    session.page = undefined;
    if (session.grant.capacityReleased) {
      session.stopped = true;
      return;
    }
    if (session.grant.kameleoProfileId)
      await this.operation(
        session,
        "stop",
        () => this.engine.stop(session.grant.kameleoProfileId!),
        20_000,
      );
    const operations = await this.coordinator.listOperations(session.grant);
    session.sequence = Math.max(
      0,
      ...operations.map((operation) => operation.sequence),
    );
    const localSequence = ++this.agentSequence;
    this.journalWrite = this.journalWrite.then(() =>
      durableWrite(
        join(this.options.dataDir, "agent-sequence"),
        String(localSequence),
      ),
    );
    await this.journalWrite;
    const kind = session.grant.kameleoProfileId
      ? "drained_and_stopped"
      : operations.length
        ? "no_browser_started"
        : "never_dispatched";
    session.grant = await this.coordinator.confirmStopped(session.grant, {
      kind,
      evidenceDigest: digest(
        `stopped:${session.grant.id}:${session.sequence}:${localSequence}`,
      ),
      localSequence,
      coversLifecycleSequence: session.sequence,
    });
    await this.coordinator.releaseProxyExit(session.grant);
    session.stopped = true;
    clearInterval(session.heartbeat);
  }
  private async save(id: string, session: Session) {
    await this.status(id, "saving");
    await this.stop(session);
    const temporary = `${id}-${randomUUID()}.partial.kameleo`,
      name = `${id}-${randomUUID()}.kameleo`;
    const localTemporary = join(this.options.localExportDir, temporary),
      localFinal = resolve(this.options.localExportDir, name);
    const engineJoin = /^[A-Za-z]:[\\/]/.test(this.options.engineExportDir)
      ? win32.join
      : posix.join;
    try {
      const exported = await this.operation(
        session,
        "export",
        () =>
          this.engine.export(
            session.grant.kameleoProfileId!,
            engineJoin(this.options.engineExportDir, temporary),
          ),
        120_000,
      );
      const info = await stat(localTemporary);
      if (!info.isFile() || !info.size) throw new Error("Empty export");
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(localTemporary))
        hash.update(chunk);
      const sha256 = hash.digest("hex");
      const handle = await open(localTemporary, "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(localTemporary, localFinal);
      const profile = await this.coordinator.getProfile(
        this.options.tenantId,
        session.grant.profileId,
      );
      const versions = this.engine.versions
        ? await bounded(
            this.engine.versions(session.grant.kameleoProfileId!),
            10_000,
          )
        : { engineVersion: "unknown", kernelVersion: "unknown" };
      const snapshot = await this.coordinator.stageSnapshot(session.grant, {
        exportOperationId: exported.operationId,
        objectKey: name,
        sha256,
        bytes: info.size,
        ...versions,
      });
      await this.coordinator.publishSnapshot(
        session.grant,
        snapshot.id,
        profile.revision,
      );
      await this.coordinator.updateMetadata(this.options.tenantId, id, {
        artifact: { name, path: localFinal, bytes: info.size, sha256 },
      });
      await this.coordinator.release(session.grant, { disposition: "saved" });
      await this.status(id, "saved");
    } catch {
      await this.status(id, "export_failed", "export_unverified");
      throw new Error("Export failed");
    }
  }
  private event(id: string, event: FlowEvent) {
    const record = this.records.get(id);
    if (!record) return;
    record.flowState = event.stateId ?? record.flowState;
    record.stepId = event.stepId ?? record.stepId;
    const message = [event.type, event.stateId, event.reason]
      .filter(Boolean)
      .join(": ");
    record.logs.push({ time: new Date(event.time).toISOString(), message });
    if (record.logs.length > 100) record.logs.shift();
    if (
      ["action-observed", "input-accepted", "flow-completed"].includes(
        event.type,
      )
    ) {
      const session = this.sessions.get(id);
      if (session) session.lastProgress = performance.now();
    }
    this.emit("run", structuredClone(record));
    void this.coordinator
      .appendEvent(
        this.options.tenantId,
        id,
        event as unknown as Record<string, unknown>,
      )
      .catch(() => {});
  }
  private async ask(
    id: string,
    title: string,
    fields: JsonSchema,
    stepSignal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const session = this.sessions.get(id)!;
    if (session.input) throw new Error("An input request is already active");
    const signal = stepSignal
      ? AbortSignal.any([session.abort.signal, stepSignal])
      : session.abort.signal;
    signal.throwIfAborted();
    const challengeId = randomUUID(),
      validate = validator.compile(fields);
    const result = new Promise<Record<string, unknown>>(
      (resolveInput, reject) => {
        session.input = {
          id: challengeId,
          validate: (value) => !!validate(value),
          resolve: resolveInput,
          reject,
        };
      },
    );
    void result.catch(() => {});
    const record = this.records.get(id)!;
    record.challenge = { id: challengeId, title, fields };
    const abort = () => session.input?.reject(new Error("Input cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try {
      await this.status(id, "awaiting_input");
      return await result;
    } finally {
      signal.removeEventListener("abort", abort);
      delete session.input;
      delete this.records.get(id)!.challenge;
    }
  }
  async provideInput(
    id: string,
    challengeId: string,
    values: Record<string, unknown>,
  ) {
    const session = this.sessions.get(id);
    if (
      !session?.input ||
      session.input.id !== challengeId ||
      !session.input.validate(values)
    )
      throw new RuntimeError("Input is invalid or no longer requested", 400);
    const pending = session.input;
    session.lastProgress = performance.now();
    try {
      await this.status(id, "running");
    } catch (error) {
      pending.reject(new Error("Input could not be committed"));
      throw error;
    }
    delete session.input;
    delete this.records.get(id)!.challenge;
    pending.resolve(structuredClone(values));
    return this.get(id);
  }
  async pause(id: string) {
    const session = this.sessions.get(id);
    if (!session) throw new RuntimeError("Run is not active");
    this.records.get(id)!.pauseRequested = true;
    this.emit("run", this.get(id));
    return this.get(id);
  }
  async resume(id: string) {
    const session = this.sessions.get(id);
    if (!session) {
      if (this.work.has(id)) throw new RuntimeError("Run is still stopping");
      const flow = await this.coordinator.getFlow(this.options.tenantId, id);
      if (
        !["interrupted", "recovering", "failed", "review"].includes(
          flow.state,
        ) ||
        Date.parse(flow.deadlineAt) <= Date.now()
      )
        throw new RuntimeError(
          "This flow cannot resume; its deadline may have expired",
        );
      await this.vault.get(id);
      const old = await this.coordinator.leaseForFlow(
        this.options.tenantId,
        id,
      );
      if (old && !old.released) {
        const sent = performance.now();
        const grant = await this.coordinator.resumeRetainedFlow(
          this.options.tenantId,
          id,
          this.incarnation,
          45_000,
        );
        if (!grant) throw new RuntimeError("Waiting for browser capacity");
        const task = this.execute(id, grant, sent + 40_000).finally(() =>
          this.work.delete(id),
        );
        this.work.set(id, task);
        void task.catch(() => {});
      } else {
        await this.coordinator.resumeFlow(this.options.tenantId, id);
        await this.refresh();
        void this.tick().catch(() => {});
      }
      return this.get(id);
    }
    this.records.get(id)!.pauseRequested = false;
    session.lastProgress = performance.now();
    session.resume?.();
    delete session.resume;
    await this.status(id, "running");
    return this.get(id);
  }
  private async waitForFinish(id: string) {
    const session = this.sessions.get(id)!,
      record = this.records.get(id)!;
    record.waitingForFinish = true;
    const waiting = new Promise<void>((resolveFinish) => {
      session.finish = resolveFinish;
    });
    this.emit("run", this.get(id));
    await bounded(waiting, this.options.idleTimeoutMs, session.abort.signal);
  }
  async done(id: string) {
    const session = this.sessions.get(id);
    if (!session?.finish)
      throw new RuntimeError("Flow is not waiting for Done");
    this.records.get(id)!.waitingForFinish = false;
    this.emit("run", this.get(id));
    session.finish();
    delete session.finish;
    return this.get(id);
  }
  async cancel(id: string) {
    const session = this.sessions.get(id);
    session?.abort.abort(new Error("Cancelled"));
    session?.input?.reject(new Error("Cancelled"));
    session?.resume?.();
    session?.finish?.();
    if (this.work.has(id)) await this.work.get(id);
    else if (this.get(id).state === "queued") {
      await this.status(id, "cancelled");
      await this.vault.delete(id);
    }
    return this.get(id);
  }
  async retryExport(id: string) {
    if (this.work.has(id)) throw new RuntimeError("Run is still active");
    const flow = await this.coordinator.getFlow(this.options.tenantId, id);
    const grant = await this.coordinator.leaseForFlow(
      this.options.tenantId,
      id,
    );
    if (
      !["export_failed", "recovering", "interrupted"].includes(flow.state) ||
      !grant ||
      grant.released ||
      !grant.kameleoProfileId
    )
      throw new RuntimeError("No retained profile is available for export");
    if (
      (await this.coordinator.listPendingOperations(grant)).length ||
      (flow.checkpoint as unknown as FlowSnapshot).pending
    )
      throw new RuntimeError(
        "An operation is unresolved. The profile remains held for review.",
      );
    const session: Session = {
      grant,
      abort: new AbortController(),
      deadline: 0,
      sequence: 0,
      stopped: grant.capacityReleased,
      uncertain: false,
      lastProgress: 0,
    };
    const task = this.save(id, session).finally(() => this.work.delete(id));
    this.work.set(id, task);
    await task;
    await this.vault.delete(id);
    return this.get(id);
  }
  async evidence(id: string) {
    this.get(id);
    return this.coordinator.listEvents(this.options.tenantId, id, 0, 1000);
  }
  async stats() {
    return this.coordinator.stats(this.quotaId);
  }
  async screenshot(id: string) {
    const session = this.sessions.get(id);
    if (!session?.page || session.stopped)
      throw new RuntimeError("No browser is attached");
    session.abort.signal.throwIfAborted();
    if (performance.now() >= session.deadline)
      throw new RuntimeError("Lease expired");
    return Buffer.from(
      await bounded(
        session.page.screenshot({ type: "jpeg", quality: 75 }),
        5000,
      ),
    );
  }
  private async recover() {
    const leases = await this.coordinator.listNodeLeases(
      this.options.tenantId,
      this.options.nodeId,
    );
    for (const lease of leases) {
      const pending = await this.coordinator.listPendingOperations(lease);
      if (pending.length) {
        await this.coordinator.quarantine(lease, "unknown_engine_operation");
        continue;
      }
      const session: Session = {
        grant: lease,
        abort: new AbortController(),
        deadline: 0,
        sequence: 0,
        stopped: false,
        uncertain: false,
        lastProgress: 0,
      };
      try {
        if (!lease.kameleoProfileId && this.engine.findByRunId) {
          const found = await bounded(
            this.engine.findByRunId(lease.flowId),
            10_000,
          );
          if (found) {
            await this.coordinator.recordProfileCreated(lease, found.id);
            lease.kameleoProfileId = found.id;
          }
        }
        await this.stop(session);
        const flow = await this.coordinator.getFlow(
          this.options.tenantId,
          lease.flowId,
        );
        if (
          flow.state === "export_failed" ||
          (flow.checkpoint as unknown as FlowSnapshot).status === "completed"
        ) {
          await this.status(
            lease.flowId,
            "export_failed",
            "restart_export_review",
          );
          continue;
        }
        if (!(flow.checkpoint as unknown as FlowSnapshot).pending)
          await this.coordinator.release(lease, { disposition: "preserved" });
        await this.status(
          lease.flowId,
          "interrupted",
          "restart_review_required",
        );
      } catch {
        await this.coordinator.quarantine(lease, "restart_stop_unconfirmed");
      }
    }
    try {
      await this.coordinator.markNodeReady(
        this.options.tenantId,
        this.options.nodeId,
        this.incarnation,
      );
    } catch {
      /* Unresolved operations retain their slots. */
    }
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    for (const [id, session] of this.sessions)
      if (this.records.get(id)?.state !== "saving")
        session.abort.abort(new Error("Workbench stopping"));
    await Promise.allSettled([...this.work.values()]);
    await this.unlock?.();
    await this.db.close();
  }
}
