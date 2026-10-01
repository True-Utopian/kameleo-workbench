import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';

class FakeRuntime extends EventEmitter {
  run = { id: 'one', state: 'running', artifact: undefined as any };
  listAutomations() { return [{ id: 'fixture', title: 'Fixture' }]; }
  submit() { return this.run; }
  list() { return [this.run]; }
  get(id: string) { if (id !== 'one') throw new Error('Missing'); return this.run; }
  cancel() {} pause() {} resume() {} retryExport() {} done() {} provideInput() {}
  async screenshot() { return Buffer.from('test-image'); }
}
const token = 'a-valid-test-access-token-with-enough-entropy';
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'workbench-api-'));
  const config = await loadConfig({ WORKBENCH_DATA_DIR: directory, EXPORT_DIR: directory, WORKBENCH_TOKEN: token });
  const runtime = new FakeRuntime();
  const app = await createServer(config, runtime, { publicInventory: () => [] });
  return { directory, runtime, app, close: async () => { await app.close(); await rm(directory, { recursive: true, force: true }); } };
}
test('authentication gates API and rejects cross-origin cookies and websocket attempts', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.app.inject('/api/runs')).statusCode, 401);
    const login = await f.app.inject({ method: 'POST', url: '/api/login', payload: { token } });
    assert.equal(login.statusCode, 200);
    const cookie = login.cookies[0]!;
    assert.equal(cookie.httpOnly, true); assert.equal(cookie.sameSite, 'Strict');
    const cookies = { workbench: cookie.value };
    assert.equal((await f.app.inject({ url: '/api/runs', cookies })).statusCode, 200);
    assert.equal((await f.app.inject({ url: '/api/runs', cookies, headers: { origin: 'https://unrelated.example' } })).statusCode, 403);
    assert.equal((await f.app.inject({ url: '/api/runs/one/view/socket', cookies, headers: { origin: 'https://unrelated.example' } })).statusCode, 403);
    await f.app.inject({ method: 'POST', url: '/api/logout', cookies });
    assert.equal((await f.app.inject({ url: '/api/runs', cookies })).statusCode, 401);
  } finally { await f.close(); }
});
test('bearer API validates requests and confines profile downloads', async () => {
  const f = await fixture(); const headers = { authorization: `Bearer ${token}` };
  try {
    assert.equal((await f.app.inject({ url: '/api/runs/missing', headers })).statusCode, 404);
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/runs', headers, payload: { automationId: 'fixture', inputs: {}, preset: 'undetectable' } })).statusCode, 400);
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/runs', headers, payload: { automationId: 'fixture', inputs: {} } })).statusCode, 202);
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/runs', headers, payload: { automationId: 'fixture', inputs: {}, preset: { typingDelayMs: 20, pointerSteps: 8 } } })).statusCode, 202);
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/runs', headers, payload: { automationId: 'fixture', inputs: {}, preset: { pointerSteps: 500 } } })).statusCode, 400);
    assert.equal((await f.app.inject({ url: '/api/runs/one/artifact', headers })).statusCode, 409);
    const file = path.join(f.directory, 'one.kameleo'); await writeFile(file, 'verified-profile');
    f.runtime.run.state = 'saved'; f.runtime.run.artifact = { path: file };
    const download = await f.app.inject({ url: '/api/runs/one/artifact', headers });
    assert.equal(download.statusCode, 200); assert.equal(download.body, 'verified-profile');
    f.runtime.run.artifact = { path: path.resolve('package.json') };
    assert.equal((await f.app.inject({ url: '/api/runs/one/artifact', headers })).statusCode, 403);
  } finally { await f.close(); }
});

async function deadline<T>(operation: Promise<T>, milliseconds = 1500): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('Operation exceeded regression-test deadline')), milliseconds); })]);
  } finally { if (timeout) clearTimeout(timeout); }
}

test('logout immediately closes the cookie-authenticated SSE stream and removes its listener', { timeout: 5000 }, async () => {
  const f = await fixture();
  const controller = new AbortController();
  try {
    const url = await f.app.listen({ host: '127.0.0.1', port: 0 });
    const login = await fetch(`${url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    await login.arrayBuffer();
    const baseline = f.runtime.listenerCount('run');
    const events = await fetch(`${url}/api/events`, { headers: { cookie }, signal: controller.signal });
    const reader = events.body!.getReader();
    assert.equal((await deadline(reader.read())).done, false);
    assert.equal(f.runtime.listenerCount('run'), baseline + 1);
    const logout = await fetch(`${url}/api/logout`, { method: 'POST', headers: { cookie } });
    await logout.arrayBuffer();
    assert.equal(logout.status, 200);
    f.runtime.emit('run', { id: 'should-not-be-sent', state: 'running' });
    assert.equal((await deadline(reader.read(), 500)).done, true);
    assert.equal(f.runtime.listenerCount('run'), baseline);
  } finally { controller.abort(); await deadline(f.close()); }
});

test('server shutdown ends open SSE streams rather than waiting indefinitely', { timeout: 5000 }, async () => {
  const f = await fixture();
  const controller = new AbortController();
  try {
    const url = await f.app.listen({ host: '127.0.0.1', port: 0 });
    const events = await fetch(`${url}/api/events`, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
    const reader = events.body!.getReader();
    await deadline(reader.read());
    await deadline(f.app.close(), 1000);
    assert.equal((await deadline(reader.read())).done, true);
    assert.equal(f.runtime.listenerCount('run'), 0);
  } finally { controller.abort(); await deadline(f.close()); }
});
