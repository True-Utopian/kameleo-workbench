import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { PGlite } from '@electric-sql/pglite';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { LocalEngine } from '../dist/local-engine.js';
import { ManagedRuntime } from '../dist/managed/runtime.js';
import { fixturePolicies, registerFixture } from '../dist/fixture.js';

// Embedded PostgreSQL verifies local flow integration; it does not test PostgreSQL advisory locks.
class FixtureDatabase {
  engine = new PGlite();
  async query(sql, values) { const result = values ? await this.engine.query(sql, values) : (await this.engine.exec(sql)).at(-1); return { rows: result?.rows ?? [], rowCount: result?.affectedRows }; }
  async transaction(body) { return this.engine.transaction(async tx => body({ query: async (sql, values) => { const r = values ? await tx.query(sql, values) : (await tx.exec(sql)).at(-1); return { rows: r?.rows ?? [], rowCount: r?.affectedRows }; } })); }
  async holdNodeLock() { return async () => {}; }
  async close() { await this.engine.close(); }
}
const directory = await mkdtemp(join(tmpdir(), 'workbench-local-flow-'));
const executablePath = process.env.LOCAL_BROWSER_EXECUTABLE || JSON.parse(await readFile(resolve('.workbench/local-engine/browser.json'), 'utf8')).executablePath;
const engine = new LocalEngine({ directory: join(directory, 'engine'), executablePath, headless: true });
const database = new FixtureDatabase(), app = Fastify(); await app.register(cookie);
const token = 'synthetic-local-flow-fixture-token'; await registerFixture(app, token);
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const runtime = new ManagedRuntime({ databaseUrl: 'embedded-smoke-only', database, engine, tenantId: randomUUID(), nodeId: randomUUID(), teamKey: 'local-flow-smoke', browserBudget: 1, engineUrl: 'http://unused.invalid', dataDir: join(directory, 'state'), flowsDir: resolve('flows'), localExportDir: join(directory, 'exports'), engineExportDir: join(directory, 'exports'), maxConcurrency: 1, runTimeoutMs: 60_000, idleTimeoutMs: 30_000, fixtureOrigin: origin, policies: fixturePolicies(token, origin) });
const username = `fixture-${randomUUID().slice(0, 8)}`;
async function run(identityId) {
  const run = await runtime.submit({ automationId: 'owned-account-signin', inputs: { username, password: 'test-password' }, preset: 'fast', ...(identityId ? { identityId } : {}) });
  const deadline = Date.now() + 60_000, answered = new Set(); let done = false;
  while (Date.now() < deadline) {
    const record = runtime.get(run.id);
    if (record.challenge && !answered.has(record.challenge.id)) {
      const properties = record.challenge.fields.properties;
      if (properties.decision) throw new Error(`Flow requested review: ${JSON.stringify(record)}`);
      const value = properties.value.enum?.[0] ?? '123456'; answered.add(record.challenge.id);
      await runtime.provideInput(run.id, record.challenge.id, { value });
    }
    if (record.waitingForFinish && !done) { done = true; await runtime.done(run.id); }
    if (record.state === 'saved') {
      const bytes = await readFile(record.artifact.path);
      assert.match(record.artifact.name, /\.workbench\.tgz$/);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), record.artifact.sha256);
      return record;
    }
    if (['failed', 'cancelled', 'interrupted', 'export_failed'].includes(record.state)) throw new Error(`Managed local flow failed: ${JSON.stringify(record)}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Managed local flow timed out');
}
try {
  await engine.ready(); await runtime.init();
  const cold = await run(); assert.ok(cold.identityId);
  const warm = await run(cold.identityId); assert.equal(warm.profileId, cold.profileId);
  const rebound = await run(); assert.equal(rebound.profileId, cold.profileId);
  console.log(JSON.stringify({ passed: true, checks: ['managed cold sign-in', 'verification input', 'identity binding', 'warm profile reuse', 'anonymous identity handoff', 'verified local archives'], runs: [cold, warm, rebound].map(r => ({ elapsedMs: Date.parse(r.updatedAt) - Date.parse(r.createdAt), bytes: r.artifact.bytes })) }, null, 2));
} finally { await runtime.close(); await engine.close(); await app.close(); await rm(directory, { recursive: true, force: true }); }
