import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Runtime, type RuntimeOptions, type RunRecord } from '../src/runtime.js';
import type { EngineAdapter } from '../src/engine.js';

class FakeEngine implements EngineAdapter {
  calls: string[] = []; exports = 0; failExport = false; failStop = false;
  constructor(private output: string) {}
  async ready() { this.calls.push('ready'); }
  async create(settings: Record<string, unknown>) { this.calls.push('create'); return { id: `profile-${this.calls.filter(x => x === 'create').length}` }; }
  async install(id: string) { this.calls.push(`install:${id}`); }
  async start(id: string) { this.calls.push(`start:${id}`); }
  async stop(id: string) { this.calls.push(`stop:${id}`); if (this.failStop) throw new Error('stop failed'); }
  async export(id: string, path: string) { this.calls.push(`export:${id}`); this.exports++; if (this.failExport) throw new Error('export failed'); await writeFile(join(this.output, basename(path)), 'portable profile archive'); }
}
async function setup(options: Partial<RuntimeOptions> = {}, module = "export default { id:'fixture', title:'Fixture', inputSchema:{type:'object',additionalProperties:true}, async run(){} };") {
  const dir = await mkdtemp(join(tmpdir(), 'workbench-runtime-')); const exports = join(dir, 'exports'); const automations = join(dir, 'automations');
  await mkdir(exports); await mkdir(automations); await writeFile(join(automations, 'fixture.mjs'), module);
  const engine = new FakeEngine(exports);
  const settings: RuntimeOptions = { engineUrl: 'http://127.0.0.1:5050', dataDir: join(dir, 'runs'), engineExportDir: '/engine/exports', localExportDir: exports, automationsDir: automations, engine, runner: async () => true, ...options };
  const runtime = new Runtime(settings); await runtime.init();
  return { runtime, engine, dir, settings, async cleanup() { await runtime.close(); await rm(dir, { recursive: true, force: true }); } };
}
async function until(runtime: Runtime, id: string, predicate: (record: RunRecord) => boolean) {
  for (let attempt = 0; attempt < 300; attempt++) { const record = runtime.get(id); if (predicate(record)) return record; await delay(10); }
  throw new Error(`Run did not reach expected state: ${runtime.get(id).state}`);
}
test('explicit completion stops before verified atomic export and never persists inputs', async () => {
  const fixture = await setup({ runner: async context => { context.log(`input ${context.inputs.password}`); return true; } });
  try {
    const run = await fixture.runtime.submit({ automationId: 'fixture', inputs: { password: 'private-password-123' } });
    const saved = await until(fixture.runtime, run.id, r => r.state === 'saved');
    assert.ok(saved.artifact); assert.equal(saved.artifact.bytes, 24); assert.match(saved.artifact.sha256, /^[a-f0-9]{64}$/);
    assert.equal(await readFile(saved.artifact.path, 'utf8'), 'portable profile archive');
    assert.ok(fixture.engine.calls.indexOf('stop:profile-1') < fixture.engine.calls.indexOf('export:profile-1'));
    await fixture.runtime.close();
    const metadata = await readFile(join(fixture.dir, 'runs', `run-${run.id}.json`), 'utf8');
    assert.ok(!metadata.includes('private-password-123')); assert.ok(metadata.includes('[redacted]')); assert.ok(!metadata.includes('"inputs"'));
  } finally { await fixture.cleanup(); }
});
test('failed export retries only export and retains profile', async () => {
  let scripts = 0; const fixture = await setup({ runner: async () => { scripts++; return true; } }); fixture.engine.failExport = true;
  try {
    const run = await fixture.runtime.submit({ automationId: 'fixture', inputs: {} });
    await until(fixture.runtime, run.id, r => r.state === 'export_failed');
    await delay(20); fixture.engine.failExport = false;
    const saved = await fixture.runtime.retryExport(run.id);
    assert.equal(saved.state, 'saved'); assert.equal(scripts, 1); assert.equal(fixture.engine.exports, 2); assert.equal(saved.profileId, 'profile-1');
  } finally { await fixture.cleanup(); }
});
test('returning without explicit completion fails and stops without exporting', async () => {
  const fixture = await setup({ runner: async () => false });
  try {
    const run = await fixture.runtime.submit({ automationId: 'fixture', inputs: {} });
    const failed = await until(fixture.runtime, run.id, r => r.state === 'failed');
    assert.equal(failed.profileId, 'profile-1'); assert.equal(fixture.engine.exports, 0); assert.ok(fixture.engine.calls.includes('stop:profile-1'));
  } finally { await fixture.cleanup(); }
});
test('queue enforces concurrency and cancellation stops active browser without export', async () => {
  let starts = 0;
  const fixture = await setup({ maxConcurrency: 1, runner: async context => { starts++; await new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true })); return false; } });
  try {
    const first = await fixture.runtime.submit({ automationId: 'fixture', inputs: {} });
    await until(fixture.runtime, first.id, r => r.state === 'running');
    const second = await fixture.runtime.submit({ automationId: 'fixture', inputs: {} });
    assert.equal(second.state, 'queued'); assert.equal(starts, 1);
    assert.equal((await fixture.runtime.cancel(first.id)).state, 'cancelled');
    await until(fixture.runtime, second.id, r => r.state === 'running');
    assert.equal(starts, 2); await fixture.runtime.cancel(second.id); assert.equal(fixture.engine.exports, 0);
  } finally { await fixture.cleanup(); }
});
test('pause is acknowledged only at checkpoint, then resumes', async () => {
  let checkpoint!: () => void; const gate = new Promise<void>(resolve => { checkpoint = resolve; });
  const fixture = await setup({ runner: async context => { await gate; await context.checkpoint(); return true; } });
  try {
    const run = await fixture.runtime.submit({ automationId: 'fixture', inputs: {} }); await until(fixture.runtime, run.id, r => r.state === 'running');
    const requested = await fixture.runtime.pause(run.id); assert.equal(requested.state, 'running'); assert.equal(requested.pauseRequested, true);
    checkpoint(); await until(fixture.runtime, run.id, r => r.state === 'paused'); await fixture.runtime.resume(run.id);
    await until(fixture.runtime, run.id, r => r.state === 'saved');
  } finally { checkpoint(); await fixture.cleanup(); }
});
test('human input is validated, kept ephemeral and explicit Done completes', async () => {
  const fixture = await setup({ runner: async context => {
    const values = await context.requestInput('Enter a code', { type: 'object', required: ['code'], additionalProperties: false, properties: { code: { type: 'string', minLength: 6, maxLength: 6, writeOnly: true } } });
    context.log(`Received ${values.code}`); await context.waitForFinish(); return true;
  } });
  try {
    const run = await fixture.runtime.submit({ automationId: 'fixture', inputs: {} }); const waiting = await until(fixture.runtime, run.id, r => r.state === 'awaiting_input');
    await assert.rejects(fixture.runtime.provideInput(run.id, waiting.challenge!.id, { code: 'bad' }), /schema/);
    await fixture.runtime.provideInput(run.id, waiting.challenge!.id, { code: '837261' });
    await until(fixture.runtime, run.id, r => r.waitingForFinish === true); await fixture.runtime.done(run.id);
    await until(fixture.runtime, run.id, r => r.state === 'saved'); await fixture.runtime.close();
    assert.ok(!(await readFile(join(fixture.dir, 'runs', `run-${run.id}.json`), 'utf8')).includes('837261'));
  } finally { await fixture.cleanup(); }
});
test('a hanging asynchronous profile hook times out before engine creation', async () => {
  const fixture = await setup({ runTimeoutMs: 100 }, "export default {id:'fixture',title:'Fixture',profile:()=>new Promise(()=>{}),async run(){}};");
  try {
    const run = await fixture.runtime.submit({ automationId: 'fixture', inputs: {} });
    const failed = await until(fixture.runtime, run.id, r => r.state === 'failed'); assert.match(failed.error!, /time limit/); assert.ok(!fixture.engine.calls.includes('create'));
  } finally { await fixture.cleanup(); }
});
test('late-created profile after timeout is retained and stopped', async () => {
  const fixture = await setup({ runTimeoutMs: 100 });
  fixture.engine.create = async () => { await delay(180); return { id: 'late-profile' }; };
  try {
    const run = await fixture.runtime.submit({ automationId: 'fixture', inputs: {} }); await until(fixture.runtime, run.id, r => r.state === 'failed');
    const late = await until(fixture.runtime, run.id, r => r.profileId === 'late-profile'); assert.equal(late.state, 'failed');
    assert.ok(fixture.engine.calls.includes('stop:late-profile')); assert.equal(fixture.engine.exports, 0);
  } finally { await fixture.cleanup(); }
});
test('unconfirmed browser stop blocks the next queued profile until recovery', async () => {
  const fixture = await setup({ runner: async () => false, maxConcurrency: 1 }); fixture.engine.failStop = true;
  try {
    const first = await fixture.runtime.submit({ automationId: 'fixture', inputs: {} });
    await until(fixture.runtime, first.id, r => r.state === 'failed' && r.cleanupRequired === true);
    const next = await fixture.runtime.submit({ automationId: 'fixture', inputs: {} }); await delay(30);
    assert.equal(fixture.runtime.get(next.id).state, 'queued'); assert.equal(fixture.engine.calls.filter(c => c === 'create').length, 1);
    fixture.engine.failStop = false; assert.equal((await fixture.runtime.retryExport(first.id)).state, 'saved');
    await until(fixture.runtime, next.id, r => r.state === 'failed');
    assert.equal(fixture.engine.calls.filter(c => c === 'create').length, 2);
  } finally { fixture.engine.failStop = false; await fixture.cleanup(); }
});
test('restart reconciles a known browser and holds admission if cleanup fails', async () => {
  const fixture = await setup(); await fixture.runtime.close();
  const timestamp = new Date().toISOString();
  await writeFile(join(fixture.settings.dataDir, 'run-11111111-1111-1111-1111-111111111111.json'), JSON.stringify({ id: '11111111-1111-1111-1111-111111111111', automationId: 'fixture', profileId: 'old-profile', state: 'running', createdAt: timestamp, updatedAt: timestamp, logs: [], timings: {} }));
  fixture.engine.failStop = true; const recovered = new Runtime(fixture.settings);
  try {
    await recovered.init(); const old = recovered.get('11111111-1111-1111-1111-111111111111'); assert.equal(old.state, 'interrupted'); assert.equal(old.cleanupRequired, true);
    const next = await recovered.submit({ automationId: 'fixture', inputs: {} }); await delay(30); assert.equal(recovered.get(next.id).state, 'queued'); assert.ok(fixture.engine.calls.includes('stop:old-profile'));
    fixture.engine.failStop = false; await recovered.retryExport(old.id); await until(recovered, next.id, r => r.state === 'saved');
  } finally { await recovered.close(); await fixture.cleanup(); }
});
test('late logs after timeout cannot persist inputs after redaction state is released', async () => {
  const fixture = await setup({ runTimeoutMs: 100, runner: async context => { await delay(160); context.log(String(context.inputs.secret)); return true; } });
  try {
    const run = await fixture.runtime.submit({ automationId: 'fixture', inputs: { secret: 'late-sensitive-secret' } });
    await until(fixture.runtime, run.id, r => r.state === 'failed'); await delay(120); await fixture.runtime.close();
    const metadata = await readFile(join(fixture.dir, 'runs', `run-${run.id}.json`), 'utf8'); assert.ok(!metadata.includes('late-sensitive-secret')); assert.equal(fixture.engine.exports, 0);
  } finally { await fixture.cleanup(); }
});
test('cancelled pending creation holds admission until late browser cleanup', async () => {
  const fixture = await setup({ runTimeoutMs: 100, maxConcurrency: 1 });
  let creations = 0; fixture.engine.create = async () => { creations++; if (creations === 1) await delay(200); return { id: `pending-${creations}` }; };
  try {
    const first = await fixture.runtime.submit({ automationId: 'fixture', inputs: {} });
    await until(fixture.runtime, first.id, r => r.state === 'failed' && r.cleanupRequired === true);
    const next = await fixture.runtime.submit({ automationId: 'fixture', inputs: {} }); await delay(30); assert.equal(creations, 1); assert.equal(fixture.runtime.get(next.id).state, 'queued');
    await until(fixture.runtime, next.id, r => r.state === 'saved'); assert.ok(fixture.engine.calls.indexOf('stop:pending-1') < fixture.engine.calls.indexOf('start:pending-2'));
  } finally { await fixture.cleanup(); }
});
test('retry cannot bypass quarantine while a timed-out start is still pending', async () => {
  const fixture = await setup({ runTimeoutMs: 100 });
  fixture.engine.start = async id => { await delay(200); fixture.engine.calls.push(`start:${id}`); };
  try {
    const run = await fixture.runtime.submit({ automationId: 'fixture', inputs: {} });
    await until(fixture.runtime, run.id, r => r.state === 'failed' && r.cleanupRequired === true);
    await assert.rejects(fixture.runtime.retryExport(run.id), /still pending/);
    await until(fixture.runtime, run.id, r => r.cleanupRequired === false);
    assert.equal(fixture.engine.exports, 0);
  } finally { await fixture.cleanup(); }
});
test('recovery releases a retained lease even after the active run is removed', async () => {
  const released: string[] = [];
  const fixture = await setup({ defaultProxyRequest: { provider: 'test' }, proxies: { allocate: async () => ({ id: 'lease-one', proxy: { value: 'http' } }), release: id => { released.push(id); } }, runner: async () => false });
  fixture.engine.failStop = true;
  try {
    const run = await fixture.runtime.submit({ automationId: 'fixture', inputs: {} });
    await until(fixture.runtime, run.id, r => r.state === 'failed' && r.cleanupRequired === true); assert.deepEqual(released, []);
    fixture.engine.failStop = false; await fixture.runtime.retryExport(run.id); assert.deepEqual(released, ['lease-one']);
  } finally { fixture.engine.failStop = false; await fixture.cleanup(); }
});
test('export timeout frees execution and a late archive is not published', async () => {
  const fixture = await setup({ exportTimeoutMs: 60 }); let temporaryPath = '';
  fixture.engine.export = async (_id, path) => { temporaryPath = join(fixture.settings.localExportDir, basename(path)); await delay(140); await writeFile(temporaryPath, 'late archive'); };
  try {
    const run = await fixture.runtime.submit({ automationId: 'fixture', inputs: {} });
    const failed = await until(fixture.runtime, run.id, r => r.state === 'export_failed'); assert.equal(failed.artifact, undefined);
    await delay(140); await assert.rejects(readFile(temporaryPath)); assert.equal(fixture.runtime.get(run.id).state, 'export_failed');
  } finally { await fixture.cleanup(); }
});
test('cloud storage is rejected before profile creation', async () => {
  const fixture = await setup({}, "export default {id:'fixture',title:'Fixture',profile:()=>({storage:'cloud'}),async run(){}};");
  try { const run = await fixture.runtime.submit({ automationId: 'fixture', inputs: {} }); await until(fixture.runtime, run.id, r => r.state === 'failed'); assert.ok(!fixture.engine.calls.includes('create')); }
  finally { await fixture.cleanup(); }
});
