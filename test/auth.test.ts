import test from 'node:test';
import assert from 'node:assert/strict';
import { AccessControl } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('sessions expire and logout revokes access', () => {
  let now = 1000;
  const auth = new AccessControl('test-token-with-enough-length', () => now);
  const id = auth.login('test-token-with-enough-length', 'local');
  assert.equal(auth.valid(id), true);
  auth.logout(id); assert.equal(auth.valid(id), false);
  const next = auth.login('test-token-with-enough-length', 'local');
  now += 13 * 60 * 60 * 1000; assert.equal(auth.valid(next), false);
});

test('invalid attempts are bounded and recover after the window', () => {
  let now = 0;
  const auth = new AccessControl('test-token-with-enough-length', () => now);
  for (let i = 0; i < 10; i++) assert.throws(() => auth.login('bad', 'local'), /Invalid/);
  assert.throws(() => auth.login('test-token-with-enough-length', 'local'), /Too many/);
  now = 61_000;
  assert.ok(auth.login('test-token-with-enough-length', 'local'));
  assert.equal(auth.matches('short'), false);
});

test('generated token survives restart and shared displays reject concurrent runs', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'workbench-config-'));
  try {
    const env = { WORKBENCH_DATA_DIR: folder };
    const first = await loadConfig(env); const second = await loadConfig(env);
    assert.equal(first.token, second.token); assert.ok(first.token.length >= 32);
    await assert.rejects(loadConfig({ ...env, KAMELEO_VNC_URL: 'ws://localhost:5050/vnc', MAX_CONCURRENCY: '2' }), /MAX_CONCURRENCY/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('external browser connection stays on numeric loopback and requires a private token file', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'vesper-connection-config-'));
  const env = { WORKBENCH_DATA_DIR: folder, WORKBENCH_TOKEN: 'test-token-with-enough-length', VESPER_BROWSER_TOKEN_FILE: path.join(folder, 'browser-token') };
  try {
    for (const url of ['https://127.0.0.1:3181', 'http://example.com', 'http://localhost:3181', 'http://user:password@127.0.0.1:3181', 'http://127.0.0.1:3181/api', 'http://127.0.0.1:3181/?token=value']) {
      await assert.rejects(loadConfig({ ...env, VESPER_BROWSER_URL: url }), /numeric loopback/);
    }
    await assert.rejects(loadConfig({ ...env, VESPER_BROWSER_TOKEN_FILE: undefined, VESPER_BROWSER_URL: 'http://127.0.0.1:3181' }), /TOKEN_FILE/);
    await assert.rejects(loadConfig({ ...env, BROWSER_BACKEND: 'kameleo', VESPER_BROWSER_URL: 'http://127.0.0.1:3181' }), /numeric loopback/);
    const config = await loadConfig({ ...env, VESPER_BROWSER_URL: 'http://127.0.0.1:3181/' });
    assert.equal(config.vesperBrowserUrl, 'http://127.0.0.1:3181');
    assert.equal(config.vesperBrowserTokenFile, path.join(folder, 'browser-token'));
  } finally { await rm(folder, { recursive: true, force: true }); }
});
