import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalEngine } from '../src/local-engine.js';
import * as tar from 'tar';
import { loadConfig } from '../src/config.js';
import { createServer } from '../src/server.js';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { InputVault } from '../src/managed/storage.js';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-local-'));
  const engine = new LocalEngine({ directory: join(directory, 'engine'), executablePath: process.execPath });
  return { directory, engine, async close() { await engine.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('local profiles reject unsupported spoofing fields and never expose proxy credentials', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.engine.create({ fingerprintId: 'vendor-only' }), /Unsupported/);
    await assert.rejects(f.engine.create({ timezone: 'Invalid/Zone' }));
    await assert.rejects(f.engine.create({ proxy: { value: 'http', extra: { host: 'bad@host', port: 80 } } }));
    const p = await f.engine.create({ name: 'Isolated', timezone: 'Europe/London', locale: 'en-GB', proxy: { value: 'socks5', extra: { host: '127.0.0.1', port: 9999, id: 'private-user', secret: 'private-password' } } });
    const profiles = await f.engine.listProfiles();
    assert.equal(profiles[0]?.id, p.id); assert.equal(profiles[0]?.hasProxy, true);
    assert.ok(!JSON.stringify(profiles).includes('private-'));
    assert.ok(!(await readFile(join(f.directory, 'engine', 'profiles', p.id, 'manifest.json'), 'utf8')).includes('private-'));
    const sealed = await readFile(join(f.directory, 'engine', 'secrets', `${p.id}.sealed`));
    assert.ok(!sealed.includes(Buffer.from('private-password')));
    const legacyVault = new InputVault(join(f.directory, 'engine', 'secrets'));
    await legacyVault.init();
    assert.equal((await legacyVault.get<{ extra: { secret: string } }>(p.id)).extra.secret, 'private-password');
    await f.engine.update(p.id, { name: 'Edited', proxy: null });
    assert.equal((await f.engine.readProfile(p.id)).hasProxy, false);
    await assert.rejects(readFile(join(f.directory, 'engine', 'secrets', `${p.id}.sealed`)), { code: 'ENOENT' });
    await f.engine.stop(p.id); await f.engine.stop(p.id);
  } finally { await f.close(); }
});

test('profile export and import restore storage, discard caches and require rebinding a proxy', async () => {
  const f = await fixture();
  try {
    const p = await f.engine.create({ name: 'Stored profile', proxy: { value: 'http', extra: { host: '127.0.0.1', port: 8888, secret: 'not-in-archive' } } });
    const browser = join(f.directory, 'engine', 'profiles', p.id, 'browser');
    await mkdir(join(browser, 'Default', 'Cache'), { recursive: true });
    await writeFile(join(browser, 'Default', 'Cache', 'discard-me'), 'cache');
    await writeFile(join(browser, 'Default', 'Cookies'), 'persistent browser state');
    const archive = join(f.directory, 'profile.workbench.tgz'); await f.engine.export(p.id, archive);
    const entries: string[] = [];
    await tar.t({ file: archive, onReadEntry: entry => { entries.push(entry.path); } });
    assert.ok(entries.includes('browser/Default/Cookies'));
    assert.ok(!entries.some(name => name.includes('Cache') || name.includes('sealed') || name.includes('session')));
    const imported = await f.engine.importProfile(archive);
    assert.notEqual(imported.id, p.id);
    assert.equal(await readFile(join(f.directory, 'engine', 'profiles', imported.id, 'browser', 'Default', 'Cookies'), 'utf8'), 'persistent browser state');
    assert.equal((await f.engine.readProfile(imported.id)).hasProxy, false);
    const duplicate = await f.engine.duplicate(p.id); assert.notEqual(duplicate.id, p.id);
    assert.equal((await f.engine.listProfiles()).length, 3);
  } finally { await f.close(); }
});

test('ownership prevents another process adapter from modifying the same profile store', async () => {
  const f = await fixture();
  const other = new LocalEngine({ directory: join(f.directory, 'engine'), executablePath: process.execPath });
  try {
    await f.engine.ready(); await assert.rejects(other.ready(), /Another Vesper Browser process owns/);
    await other.close();
    assert.ok(await readFile(join(f.directory, 'engine', 'owner.json'), 'utf8'));
    await f.engine.close();
    const next = new LocalEngine({ directory: join(f.directory, 'engine'), executablePath: process.execPath });
    try { await next.ready(); } finally { await next.close(); }
  } finally { await other.close(); await f.close(); }
});

test('malformed and linked archives are rejected without creating profiles', async () => {
  const f = await fixture();
  try {
    const source = join(f.directory, 'source'); await mkdir(source);
    await writeFile(join(source, 'secret.txt'), 'outside archive contract');
    const archive = join(f.directory, 'bad.tgz'); await tar.c({ file: archive, cwd: source, gzip: true }, ['secret.txt']);
    await assert.rejects(f.engine.importProfile(archive), /Invalid profile archive/);
    for (const type of ['SymbolicLink', 'Link'] as const) {
      const header = new tar.Header({ path: 'browser/escape', type, linkpath: '../../outside', size: 0 }); header.encode();
      await writeFile(archive, Buffer.concat([header.block!, Buffer.alloc(1024)]));
      await assert.rejects(f.engine.importProfile(archive), /Invalid profile archive/);
    }
    assert.deepEqual(await f.engine.listProfiles(), []);
    assert.ok(!(await readdir(join(f.directory, 'engine'))).some(name => name.startsWith('import-')));
  } finally { await f.close(); }
});

test('local profile HTTP controls require authentication and cannot stop an active run', async () => {
  const f = await fixture();
  const token = 'local-engine-regression-token-with-entropy';
  const config = await loadConfig({ WORKBENCH_TOKEN: token, WORKBENCH_DATA_DIR: f.directory, EXPORT_DIR: f.directory });
  const runtime = Object.assign(new EventEmitter(), {
    runs: [] as { profileId: string; state: string }[], list() { return this.runs; }, listAutomations() { return []; },
    submit() {}, get() {}, cancel() {}, pause() {}, resume() {}, retryExport() {}, done() {}, provideInput() {}, async screenshot() { return Buffer.alloc(0); },
  });
  const app = await createServer(config, runtime, { publicInventory() { return []; } }, f.engine);
  const headers = { authorization: `Bearer ${token}` };
  try {
    assert.equal((await app.inject('/api/local-profiles')).statusCode, 401);
    const created = await app.inject({ url: '/api/local-profiles', method: 'POST', headers, payload: { name: 'HTTP profile' } });
    assert.equal(created.statusCode, 201);
    const id = created.json().id;
    runtime.runs = [{ profileId: id, state: 'running' }];
    assert.equal((await app.inject({ url: `/api/local-profiles/${id}/stop`, method: 'POST', headers })).statusCode, 409);
    assert.equal((await app.inject({ url: '/api/status', headers })).json().engine.backend, 'local');
    runtime.runs = [];
    const browser = join(f.directory, 'engine', 'profiles', id, 'browser', 'Default');
    await mkdir(browser); await writeFile(join(browser, 'Cookies'), randomBytes(320_000));
    const exported = await app.inject({ url: `/api/local-profiles/${id}/archive`, headers }); assert.equal(exported.statusCode, 200);
    assert.match(exported.headers['content-disposition'] as string, /workbench\.tgz/);
    assert.ok(exported.rawPayload.length > 256 * 1024, 'Fixture must exceed the ordinary JSON body limit');
    const imported = await app.inject({ url: '/api/local-profiles/import', method: 'POST', headers: { ...headers, 'content-type': 'application/gzip' }, payload: exported.rawPayload });
    assert.equal(imported.statusCode, 201); assert.notEqual(imported.json().id, id);
    const invalid = await app.inject({ url: '/api/local-profiles/import', method: 'POST', headers: { ...headers, 'content-type': 'application/gzip' }, payload: Buffer.from('invalid archive') });
    assert.equal(invalid.statusCode, 400);
  } finally { await app.close(); await f.close(); }
});
