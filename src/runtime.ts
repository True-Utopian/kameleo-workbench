import { EventEmitter } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { readdir, mkdir, readFile, writeFile, rename, stat, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, resolve, posix, win32 } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import { Ajv } from 'ajv';
import puppeteer from 'puppeteer-core';
import { KameleoEngine, type EngineAdapter } from './engine.js';
import type { Automation, AutomationDescriptor, InputChallenge, JsonSchema } from './automation.js';
import { resolvePace, type PacePreset } from './actions.js';

export type RunState = 'queued' | 'starting' | 'running' | 'awaiting_input' | 'paused' | 'saving' | 'saved' | 'failed' | 'cancelled' | 'interrupted' | 'export_failed';
export interface RunRecord {
  id: string; automationId: string; state: RunState; createdAt: string; updatedAt: string;
  profileId?: string; error?: string; logs: { time: string; message: string }[];
  challenge?: InputChallenge; artifact?: { name: string; path: string; bytes: number; sha256: string };
  timings: Record<string, number>; pauseRequested?: boolean; waitingForFinish?: boolean;
  preset?: PacePreset; cleanupRequired?: boolean;
  proxy?: unknown;
}
interface ProxyLease { id: string; proxy: unknown; report?: unknown }
export interface RuntimeProxies {
  allocate(request: any, runId: string, signal?: AbortSignal): Promise<ProxyLease>;
  release(leaseId: string): Promise<unknown> | unknown;
}
export interface RunnerContext {
  runId: string; profileId: string; automationPath: string; inputs: Record<string, unknown>; preset: PacePreset; signal: AbortSignal;
  log(message: string): void; requestInput(title: string, fields: JsonSchema): Promise<Record<string, unknown>>;
  checkpoint(): Promise<void>; waitForFinish(): Promise<void>;
}
export interface RuntimeOptions {
  engineUrl: string; dataDir: string; engineExportDir: string; localExportDir: string; automationsDir: string;
  maxConcurrency?: number; runTimeoutMs?: number; proxies?: RuntimeProxies; defaultProxyRequest?: Record<string, unknown>;
  cleanupTimeoutMs?: number;
  exportTimeoutMs?: number;
  engine?: EngineAdapter; runner?: (context: RunnerContext) => Promise<boolean>;
}
interface Active {
  abort: AbortController; inputs: Record<string, unknown>; secrets: Set<string>; preset: PacePreset;
  resume?: () => void; input?: { id: string; schema: JsonSchema; resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void };
  finish?: () => void; lease?: ProxyLease; timedOut?: boolean; timer?: NodeJS.Timeout; stopped?: boolean; lifecyclePending?: boolean;
}
export class RuntimeError extends Error { constructor(message: string, readonly statusCode = 409) { super(message); } }
const ajv = new Ajv({ allErrors: false, strict: false });
const activeStates = new Set<RunState>(['queued', 'starting', 'running', 'awaiting_input', 'paused', 'saving']);
const copy = <T>(value: T): T => structuredClone(value);
const now = () => new Date().toISOString();
function validInputs(schema: JsonSchema, inputs: Record<string, unknown>): void {
  if (!ajv.compile(schema)(inputs)) throw new RuntimeError('Inputs do not match the automation input schema', 400);
}
function addSecrets(value: unknown, secrets: Set<string>) {
  if (typeof value === 'string' && value.length > 0) secrets.add(value);
  else if (typeof value === 'number') secrets.add(String(value));
  else if (Array.isArray(value)) value.forEach(item => addSecrets(item, secrets));
  else if (value && typeof value === 'object') Object.values(value).forEach(item => addSecrets(item, secrets));
}
export class Runtime extends EventEmitter {
  private records = new Map<string, RunRecord>();
  private automations = new Map<string, { definition: Automation; path: string }>();
  private active = new Map<string, Active>();
  private queue: string[] = [];
  private work = new Map<string, Promise<void>>();
  private persistence = Promise.resolve();
  private engine: EngineAdapter;
  private closed = false;
  private profileLocks = new Set<string>();
  private profileOperations = new Map<string, Promise<unknown>>();
  private blockedRuns = new Set<string>();
  private pendingLifecycleRuns = new Set<string>();
  private retainedLeases = new Map<string, string>();
  constructor(private options: RuntimeOptions) {
    super(); this.engine = options.engine ?? new KameleoEngine(options.engineUrl);
    if (!Number.isInteger(options.maxConcurrency ?? 1) || (options.maxConcurrency ?? 1) < 1) throw new Error('maxConcurrency must be positive');
    if (!Number.isFinite(options.runTimeoutMs ?? 1_800_000) || (options.runTimeoutMs ?? 1_800_000) < 100) throw new Error('runTimeoutMs must be at least 100');
  }
  async init(): Promise<void> {
    await Promise.all([mkdir(this.options.dataDir, { recursive: true }), mkdir(this.options.localExportDir, { recursive: true }), mkdir(this.options.automationsDir, { recursive: true })]);
    for (const name of await readdir(this.options.automationsDir)) {
      if (!name.endsWith('.mjs') && !name.endsWith('.js')) continue;
      const path = resolve(this.options.automationsDir, name);
      const loaded = await import(pathToFileURL(path).href); const definition = (loaded.default ?? loaded.automation) as Automation;
      if (!definition || typeof definition.run !== 'function' || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(definition.id) || typeof definition.title !== 'string') throw new Error(`Invalid automation module: ${name}`);
      if (this.automations.has(definition.id)) throw new Error(`Duplicate automation id: ${definition.id}`);
      ajv.compile(definition.inputSchema ?? { type: 'object', additionalProperties: false });
      this.automations.set(definition.id, { definition, path });
    }
    for (const name of await readdir(this.options.dataDir)) {
      if (!/^run-[0-9a-f-]+\.json$/.test(name)) continue;
      try {
        const record = JSON.parse(await readFile(join(this.options.dataDir, name), 'utf8')) as RunRecord;
        if (!record.id || !Array.isArray(record.logs)) continue;
        if (activeStates.has(record.state)) { record.cleanupRequired = record.state !== 'queued'; record.state = 'interrupted'; record.error = 'Coordinator restarted. Profile preserved; inspect before continuing.'; delete record.challenge; record.pauseRequested = false; record.waitingForFinish = false; }
        this.records.set(record.id, record);
        const leaseId = (record.proxy as { leaseId?: unknown } | undefined)?.leaseId;
        if (typeof leaseId === 'string') this.retainedLeases.set(record.id, leaseId);
        if (record.cleanupRequired) this.blockedRuns.add(record.id);
      } catch { /* Ignore incomplete metadata; browser data is never deleted here. */ }
    }
    // Reconcile old browser processes before admitting another headed session.
    for (const id of [...this.blockedRuns]) {
      const record = this.records.get(id)!;
      try {
        if (!record.profileId && this.engine.findByRunId) {
          const found = await this.bounded(this.engine.findByRunId(id));
          if (!found) { record.cleanupRequired = false; this.blockedRuns.delete(id); continue; }
          record.profileId = found.id;
        }
        if (!record.profileId) throw new Error('Unknown browser state');
        await this.bounded(this.engine.stop(record.profileId)); await this.releaseLease(id); record.cleanupRequired = false; this.blockedRuns.delete(id);
      } catch { record.error = 'Browser cleanup could not be confirmed after restart. New sessions are held until recovery.'; }
    }
    await this.persist();
  }
  listAutomations(): AutomationDescriptor[] { return [...this.automations.values()].map(({ definition: a }) => ({ id: a.id, title: a.title, description: a.description ?? '', inputSchema: copy(a.inputSchema ?? { type: 'object', additionalProperties: false }) })); }
  list(): RunRecord[] { return [...this.records.values()].map(copy).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  get(id: string): RunRecord { const record = this.records.get(id); if (!record) throw new RuntimeError('Run not found', 404); return copy(record); }
  async submit(request: { automationId: string; inputs: Record<string, unknown>; preset?: PacePreset }): Promise<RunRecord> {
    if (this.closed) throw new Error('Runtime is closing');
    const definition = this.automations.get(request.automationId)?.definition; if (!definition) throw new RuntimeError('Automation not found', 404);
    validInputs(definition.inputSchema ?? { type: 'object', additionalProperties: false }, request.inputs);
    const preset = request.preset ?? definition.preset ?? 'fast'; try { resolvePace(preset); } catch { throw new RuntimeError('Invalid pacing preset', 400); }
    const id = randomUUID(); const timestamp = now();
    this.records.set(id, { id, automationId: definition.id, state: 'queued', createdAt: timestamp, updatedAt: timestamp, logs: [], timings: { submittedAt: Date.now() }, preset: copy(preset) });
    const secrets = new Set<string>(); addSecrets(request.inputs, secrets);
    this.active.set(id, { abort: new AbortController(), inputs: copy(request.inputs), secrets, preset });
    this.queue.push(id); await this.changed(id); this.drain(); return this.get(id);
  }
  private drain() {
    while (!this.closed && this.work.size + this.blockedRuns.size < (this.options.maxConcurrency ?? 1) && this.queue.length) {
      const id = this.queue.shift()!; if (!this.active.has(id)) continue;
      const task = this.execute(id).finally(() => { this.work.delete(id); this.drain(); });
      this.work.set(id, task); void task.catch(() => {});
    }
  }
  private async execute(id: string) {
    const record = this.records.get(id)!; const state = this.active.get(id)!;
    const automation = this.automations.get(record.automationId)!; const signal = state.abort.signal;
    state.timer = setTimeout(() => { state.timedOut = true; state.abort.abort(new Error('Run timed out')); }, this.options.runTimeoutMs ?? 1_800_000);
    try {
      record.state = 'starting'; delete record.error; record.timings.startedAt = Date.now(); await this.changed(id);
      await this.abortable(this.engine.ready(), signal); signal.throwIfAborted();
      const hookContext = { inputs: state.inputs, runId: id, signal };
      const settings = await this.abortable(Promise.resolve(automation.definition.profile?.(hookContext)), signal) ?? {};
      const proxyRequest = await this.abortable(Promise.resolve(automation.definition.proxy?.(hookContext)), signal) ?? this.options.defaultProxyRequest;
      signal.throwIfAborted();
      if (proxyRequest) {
        if (!this.options.proxies) throw new Error('Proxy provider is not configured');
        state.lease = await this.abortable(this.options.proxies.allocate(proxyRequest, id, signal), signal, async lease => { await this.options.proxies!.release(lease.id); });
        this.retainedLeases.set(id, state.lease.id);
        settings.proxy = state.lease.proxy; record.proxy = state.lease.report;
        addSecrets(state.lease.proxy, state.secrets); signal.throwIfAborted();
      }
      if (settings.storage !== undefined && settings.storage !== 'local') throw new Error('This runtime requires local profile storage');
      addSecrets(settings.proxy, state.secrets);
      record.cleanupRequired = true; await this.changed(id);
      const creating = this.engine.create({ ...settings, storage: 'local', name: `run-${id}` }).catch(error => {
        const status = (error as { status?: number; response?: { status?: number } })?.response?.status ?? (error as { status?: number })?.status;
        if (status && [400, 401, 402, 403, 404, 422, 429].includes(status)) record.cleanupRequired = false;
        throw error;
      });
      const profile = await this.abortable(this.trackLifecycle(id, state, creating), signal, async profile => {
        record.profileId = profile.id; state.lifecyclePending = false;
        await this.stopAndReleaseLate(id, state, profile.id);
      });
      state.lifecyclePending = false;
      if (this.profileLocks.has(profile.id)) throw new Error('Profile already reserved');
      record.profileId = profile.id; record.timings.profileCreatedAt = Date.now();
      this.profileLocks.add(profile.id); await this.changed(id); signal.throwIfAborted();
      await this.abortable(this.engine.install(profile.id), signal); signal.throwIfAborted();
      await this.abortable(this.trackLifecycle(id, state, this.engine.start(profile.id)), signal, async () => {
        state.lifecyclePending = false; await this.stopAndReleaseLate(id, state, profile.id);
      });
      state.lifecyclePending = false; signal.throwIfAborted();
      record.state = 'running'; record.timings.browserReadyAt = Date.now(); await this.changed(id);
      const context: RunnerContext = { runId: id, profileId: profile.id, automationPath: automation.path, inputs: state.inputs, preset: state.preset, signal,
        log: message => { if (!signal.aborted && this.active.get(id) === state) this.log(id, message); }, checkpoint: () => this.checkpoint(id), requestInput: (title, fields) => this.ask(id, title, fields), waitForFinish: () => this.waitForFinish(id) };
      const save = await this.abortable(this.options.runner ? this.options.runner(context) : this.runChild(context), signal);
      signal.throwIfAborted();
      if (!save) throw new Error('Automation did not complete');
      clearTimeout(state.timer); record.timings.automationDoneAt = Date.now();
      await this.save(id);
    } catch {
      clearTimeout(state.timer);
      if (record.state !== 'export_failed' && record.state !== 'saved') {
        record.state = signal.aborted && !state.timedOut ? 'cancelled' : 'failed';
        record.error = state.timedOut ? 'Run exceeded its time limit. Profile preserved.' : signal.aborted ? 'Run cancelled. Profile preserved.' : 'Run failed. Profile preserved; check automation, Engine, proxy and inputs.';
        if (record.profileId) {
          try { await this.bounded(this.withProfile(record.profileId, () => this.engine.stop(record.profileId!))); state.stopped = true; if (!state.lifecyclePending) record.cleanupRequired = false; } catch { record.error += ' Browser stop could not be confirmed.'; }
        }
        await this.changed(id);
      }
    } finally {
      clearTimeout(state.timer); state.input?.reject(new Error('Run ended')); state.resume?.(); state.finish?.();
      if (state.lifecyclePending || (record.cleanupRequired && !state.stopped)) { record.cleanupRequired = true; this.blockedRuns.add(id); }
      if (state.lease && !state.lifecyclePending && (!record.profileId || state.stopped)) { try { await this.releaseLease(id); } catch { this.log(id, 'Proxy lease release could not be confirmed.'); } }
      if (record.profileId) this.profileLocks.delete(record.profileId);
      delete record.challenge; record.pauseRequested = false; record.waitingForFinish = false;
      state.inputs = {}; state.secrets.clear(); this.active.delete(id); await this.changed(id);
    }
  }
  private async bounded<T>(operation: Promise<T>): Promise<T> { return this.abortable(operation, AbortSignal.timeout(this.options.cleanupTimeoutMs ?? 10_000)); }
  private trackLifecycle<T>(id: string, state: Active, operation: Promise<T>): Promise<T> {
    state.lifecyclePending = true; this.pendingLifecycleRuns.add(id);
    return operation.finally(() => { state.lifecyclePending = false; this.pendingLifecycleRuns.delete(id); });
  }
  private async releaseLease(id: string): Promise<void> {
    const leaseId = this.retainedLeases.get(id); if (!leaseId) return;
    await this.options.proxies?.release(leaseId); this.retainedLeases.delete(id);
  }
  private withProfile<T>(profileId: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.profileOperations.get(profileId) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(operation); this.profileOperations.set(profileId, next);
    void next.finally(() => { if (this.profileOperations.get(profileId) === next) this.profileOperations.delete(profileId); }).catch(() => {});
    return next;
  }
  private abortable<T>(operation: Promise<T>, signal: AbortSignal, onLateSuccess?: (value: T) => Promise<void>): Promise<T> {
    return new Promise<T>((resolveOperation, reject) => {
      let aborted = signal.aborted;
      const abort = () => { aborted = true; reject(new Error('Operation cancelled')); };
      signal.addEventListener('abort', abort, { once: true }); if (aborted) abort();
      operation.then(value => {
        signal.removeEventListener('abort', abort);
        if (aborted) { void onLateSuccess?.(value).catch(() => {}); } else resolveOperation(value);
      }, error => { signal.removeEventListener('abort', abort); if (!aborted) reject(error); });
    });
  }
  private async stopAndReleaseLate(id: string, state: Active, profileId: string) {
    try { await this.bounded(this.withProfile(profileId, () => this.engine.stop(profileId))); state.stopped = true; await this.releaseLease(id); this.blockedRuns.delete(id); this.records.get(id)!.cleanupRequired = false; this.drain(); }
    catch { this.log(id, 'Late browser operation completed; stop could not be confirmed. Inspect Engine before reusing its proxy.'); }
    await this.changed(id);
  }
  private async save(id: string) {
    const record = this.records.get(id)!; if (!record.profileId) throw new Error('No profile to export');
    record.state = 'saving'; delete record.error; await this.changed(id);
    const name = `${id}.kameleo`; const temporary = `${id}-${randomUUID()}.partial.kameleo`;
    const localTemporary = join(this.options.localExportDir, temporary); const localFinal = join(this.options.localExportDir, name);
    const engineJoin = /^[A-Za-z]:[\\/]/.test(this.options.engineExportDir) ? win32.join : posix.join;
    try {
      await this.bounded(this.withProfile(record.profileId, () => this.engine.stop(record.profileId!)));
      const active = this.active.get(id); if (active) active.stopped = true;
      this.blockedRuns.delete(id); record.cleanupRequired = false;
      await this.releaseLease(id);
      await this.abortable(this.engine.export(record.profileId, engineJoin(this.options.engineExportDir, temporary)), AbortSignal.timeout(this.options.exportTimeoutMs ?? 120_000), async () => { await rm(localTemporary, { force: true }); });
      const info = await stat(localTemporary); if (!info.isFile() || info.size === 0) throw new Error('Export file is missing or empty');
      const hash = createHash('sha256'); for await (const chunk of createReadStream(localTemporary)) hash.update(chunk);
      await rename(localTemporary, localFinal);
      record.artifact = { name, path: resolve(localFinal), bytes: info.size, sha256: hash.digest('hex') };
      record.state = 'saved'; record.timings.savedAt = Date.now(); await this.changed(id);
    } catch {
      await rm(localTemporary, { force: true }).catch(() => {});
      record.state = 'export_failed'; record.error = 'Export could not be verified. Profile retained; retry export without rerunning automation.'; await this.changed(id);
    }
  }
  async retryExport(id: string): Promise<RunRecord> {
    const record = this.records.get(id); if (!record || (!['export_failed', 'interrupted'].includes(record.state) && !record.cleanupRequired) || !record.profileId) throw new RuntimeError('Run cannot be exported in its current state');
    if (this.pendingLifecycleRuns.has(id)) throw new RuntimeError('An Engine lifecycle operation is still pending; wait for cleanup');
    if (this.profileLocks.has(record.profileId)) throw new RuntimeError('Profile is busy');
    this.profileLocks.add(record.profileId);
    try { await this.save(id); } finally { this.profileLocks.delete(record.profileId); this.drain(); }
    return this.get(id);
  }
  async cancel(id: string): Promise<RunRecord> {
    const record = this.records.get(id); if (!record) throw new RuntimeError('Run not found', 404);
    if (record.state === 'saving') throw new RuntimeError('Export is in progress; wait for completion');
    const state = this.active.get(id); if (!state) return this.get(id);
    state.abort.abort(); state.input?.reject(new Error('Cancelled')); state.resume?.(); state.finish?.();
    if (record.state === 'queued') { this.queue = this.queue.filter(item => item !== id); this.active.delete(id); record.state = 'cancelled'; await this.changed(id); }
    else await this.work.get(id);
    return this.get(id);
  }
  async pause(id: string): Promise<RunRecord> {
    const record = this.records.get(id); if (!record || !this.active.has(id) || !['running', 'awaiting_input', 'paused'].includes(record.state)) throw new RuntimeError('Run cannot pause now');
    record.pauseRequested = true; await this.changed(id); return this.get(id);
  }
  async resume(id: string): Promise<RunRecord> {
    const record = this.records.get(id); const state = this.active.get(id); if (!record || !state) throw new RuntimeError('Run is not active');
    record.pauseRequested = false; if (record.state === 'paused') record.state = 'running'; state.resume?.(); delete state.resume; await this.changed(id); return this.get(id);
  }
  private async checkpoint(id: string) {
    const state = this.active.get(id)!; const record = this.records.get(id)!; state.abort.signal.throwIfAborted();
    if (record.pauseRequested) {
      record.state = 'paused';
      const paused = new Promise<void>(resolve => { state.resume = resolve; }); await this.changed(id); await paused;
    }
    state.abort.signal.throwIfAborted();
  }
  private async ask(id: string, title: string, fields: JsonSchema): Promise<Record<string, unknown>> {
    const state = this.active.get(id)!; const record = this.records.get(id)!; state.abort.signal.throwIfAborted();
    if (state.input) throw new Error('Only one input request may be active');
    ajv.compile(fields); const challengeId = randomUUID();
    const result = new Promise<Record<string, unknown>>((resolve, reject) => { state.input = { id: challengeId, schema: fields, resolve, reject }; });
    record.state = 'awaiting_input'; record.challenge = { id: challengeId, title: this.redact(id, title).slice(0, 200), fields: this.cleanSchema(id, fields) }; await this.changed(id);
    const abort = () => state.input?.reject(new Error('Cancelled')); state.abort.signal.addEventListener('abort', abort, { once: true });
    if (state.abort.signal.aborted) abort();
    try { return await result; } finally { state.abort.signal.removeEventListener('abort', abort); delete state.input; delete record.challenge; }
  }
  async provideInput(id: string, challengeId: string, values: Record<string, unknown>): Promise<RunRecord> {
    const state = this.active.get(id); const record = this.records.get(id); if (!state?.input || !record || state.input.id !== challengeId) throw new RuntimeError('Input challenge is no longer active');
    validInputs(state.input.schema, values); addSecrets(values, state.secrets);
    const resolveInput = state.input.resolve; delete state.input; delete record.challenge; record.state = 'running';
    await this.changed(id); resolveInput(copy(values)); return this.get(id);
  }
  private async waitForFinish(id: string) {
    const state = this.active.get(id)!; const record = this.records.get(id)!;
    state.abort.signal.throwIfAborted(); record.waitingForFinish = true;
    const waiting = new Promise<void>(resolve => { state.finish = resolve; }); await this.changed(id); await waiting; state.abort.signal.throwIfAborted();
  }
  async done(id: string): Promise<RunRecord> {
    const state = this.active.get(id); if (!state?.finish) throw new RuntimeError('Automation is not waiting for Done');
    state.finish(); delete state.finish; return this.get(id);
  }
  async screenshot(id: string): Promise<Buffer> {
    const record = this.records.get(id); if (!record?.profileId || !['running', 'paused', 'awaiting_input'].includes(record.state)) throw new Error('Browser is not available');
    return this.withProfile(record.profileId, async () => {
      if (!['running', 'paused', 'awaiting_input'].includes(record.state)) throw new Error('Browser is not available');
      const endpoint = new URL(this.options.engineUrl); endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:'; endpoint.pathname = `/puppeteer/${record.profileId}`;
      const browser = await puppeteer.connect({ browserWSEndpoint: endpoint.href, defaultViewport: null, protocolTimeout: 15_000 });
      try { const pages = await browser.pages(); if (!pages.length) throw new Error('No page available'); return Buffer.from(await pages[pages.length - 1]!.screenshot({ type: 'jpeg', quality: 75 })); } finally { await browser.disconnect(); }
    });
  }
  private runChild(context: RunnerContext): Promise<boolean> {
    return new Promise((resolveRun, reject) => {
      const worker = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './run-worker.ts' : './run-worker.js', import.meta.url));
      const child = fork(worker, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced' });
      let settled = false; let save = false;
      const abort = () => { child.kill('SIGKILL'); };
      context.signal.addEventListener('abort', abort, { once: true });
      child.on('message', (unknownMessage: unknown) => {
        if (settled || context.signal.aborted) return;
        const message = unknownMessage as Record<string, unknown>;
        const reply = (promise: Promise<unknown>) => { void promise.then(value => { if (child.connected) child.send({ type: 'reply', id: message.id, value }); }, () => { if (child.connected) child.send({ type: 'reply', id: message.id, error: 'Operation cancelled or invalid' }); }); };
        if (message.type === 'checkpoint') reply(context.checkpoint());
        else if (message.type === 'input') reply(context.requestInput(String(message.title), message.fields as JsonSchema));
        else if (message.type === 'wait_finish') reply(context.waitForFinish());
        else if (message.type === 'log') context.log(String(message.message));
        else if (message.type === 'failure') context.log(String(message.message));
        else if (message.type === 'finished') save = message.save === true;
      });
      const finish = (error?: Error) => { if (settled) return; settled = true; context.signal.removeEventListener('abort', abort); if (error || context.signal.aborted) reject(error ?? new Error('Cancelled')); else resolveRun(save); };
      child.once('error', error => finish(error)); child.once('exit', () => finish());
      child.send({ type: 'start', automationPath: context.automationPath, engineUrl: this.options.engineUrl, profileId: context.profileId, inputs: context.inputs, preset: context.preset });
      if (context.signal.aborted) abort();
    });
  }
  private redact(id: string, message: string) { let result = message; for (const secret of [...(this.active.get(id)?.secrets ?? [])].sort((a, b) => b.length - a.length)) result = result.split(secret).join('[redacted]'); return result.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[redacted]@'); }
  private cleanSchema(id: string, schema: JsonSchema): JsonSchema { const clean = copy(schema); const walk = (value: unknown) => { if (!value || typeof value !== 'object') return; const object = value as Record<string, unknown>; for (const key of ['default', 'examples', 'const', 'enum']) delete object[key]; for (const [key, child] of Object.entries(object)) { if (['title', 'description'].includes(key) && typeof child === 'string') object[key] = this.redact(id, child); else walk(child); } }; walk(clean); return clean; }
  private log(id: string, message: string) { const record = this.records.get(id); if (!record) return; record.logs.push({ time: now(), message: this.redact(id, message).slice(0, 1000) }); if (record.logs.length > 100) record.logs.shift(); void this.changed(id); }
  private async changed(id: string) { const record = this.records.get(id)!; record.updatedAt = now(); this.emit('run', copy(record)); await this.persist(id); }
  private persist(id?: string): Promise<void> {
    const snapshots = (id ? [this.records.get(id)!] : [...this.records.values()]).map(copy);
    this.persistence = this.persistence.catch(() => {}).then(async () => { for (const record of snapshots) { const file = join(this.options.dataDir, `run-${record.id}.json`); await writeFile(`${file}.tmp`, JSON.stringify(record, null, 2), { mode: 0o600 }); await rename(`${file}.tmp`, file); } });
    return this.persistence;
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const id of [...this.active.keys()]) { if (this.records.get(id)?.state !== 'saving') await this.cancel(id); }
    await Promise.allSettled([...this.work.values()]); await this.persistence;
  }
}
