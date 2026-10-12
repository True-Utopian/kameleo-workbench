import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { VesperBrowser, VesperBrowserClient, browserAccessToken, createBrowserServer } from '@true-utopian/vesper-browser';
import { Runtime } from '../dist/runtime.js';
import { createServer } from '../dist/server.js';
import { loadConfig } from '../dist/config.js';

// Real Chromium, two loopback services, fresh synthetic profiles only.
const directory = await mkdtemp(join(tmpdir(), 'vesper-pair-smoke-'));
const executablePath = process.env.LOCAL_BROWSER_EXECUTABLE || JSON.parse(await readFile(resolve('.workbench/local-engine/browser.json'), 'utf8')).executablePath;
const browser = new VesperBrowser({ directory: join(directory, 'browser'), executablePath, headless: true, maxConcurrency: 2 });
let manager, client, runtime, workbench;
const checks = [];
try {
  const token = await browserAccessToken(join(directory, 'browser'));
  manager = await createBrowserServer(browser, token);
  await new Promise((done, reject) => { manager.once('error', reject); manager.listen(0, '127.0.0.1', done); });
  const browserUrl = `http://127.0.0.1:${manager.address().port}`;
  const config = await loadConfig({ WORKBENCH_TOKEN: 'synthetic-pair-smoke-access-token', WORKBENCH_DATA_DIR: join(directory, 'runs'), EXPORT_DIR: join(directory, 'exports'), VESPER_BROWSER_URL: browserUrl, VESPER_BROWSER_TOKEN_FILE: join(directory, 'browser', 'admin-token') });
  client = new VesperBrowserClient({ url: config.vesperBrowserUrl, tokenFile: config.vesperBrowserTokenFile });
  await client.ready();
  runtime = new Runtime({ ...config, engine: client }); await runtime.init();
  workbench = await createServer(config, runtime, { publicInventory: () => [] }, client);
  const origin = await workbench.listen({ host: '127.0.0.1', port: 0 });
  const headers = { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' };
  const status = await fetch(`${origin}/api/status`, { headers });
  assert.equal((await status.json()).engine.managerUrl, browserUrl);
  const response = await fetch(`${origin}/api/runs`, { method: 'POST', headers, body: JSON.stringify({ automationId: 'demo', inputs: { url: `${origin}/demo`, message: 'Vesper pair fixture' }, preset: 'fast' }) });
  assert.equal(response.status, 202); const run = await response.json();
  let saved; const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    saved = runtime.get(run.id);
    if (saved.state === 'saved') break;
    assert.ok(!['failed', 'export_failed', 'interrupted', 'cancelled'].includes(saved.state), `Pair run failed: ${saved.state}`);
    await new Promise(done => setTimeout(done, 50));
  }
  assert.equal(saved.state, 'saved'); checks.push('Workbench completes a real Chromium automation through the independent Browser service');
  const profiles = await client.listProfiles(); assert.ok(profiles.some(profile => profile.id === saved.profileId));
  const listed = await fetch(`${origin}/api/local-profiles`, { headers }); assert.equal(listed.status, 200);
  assert.ok((await listed.json()).some(profile => profile.id === saved.profileId)); checks.push('Both apps show the same Browser-owned profile');
  const archive = await readFile(saved.artifact.path);
  assert.equal(createHash('sha256').update(archive).digest('hex'), saved.artifact.sha256); checks.push('Workbench verifies the downloaded profile archive');
  const imported = await client.importProfile(saved.artifact.path);
  assert.equal((await client.readProfile(imported.id)).hasProxy, false); checks.push('Browser accepts its streamed archive and returns an independent profile');
  await assert.rejects(client.export(imported.id, saved.artifact.path), /EEXIST/);
  assert.equal(createHash('sha256').update(await readFile(saved.artifact.path)).digest('hex'), saved.artifact.sha256); checks.push('Remote export refuses to overwrite an existing archive');
  const manual = await client.create({ name: 'Independent manager lifetime' }); await client.start(manual.id);
  const blocked = await fetch(`${origin}/api/runs`, { method: 'POST', headers, body: JSON.stringify({ automationId: 'demo', inputs: { message: 'blocked fixture' } }) });
  assert.equal(blocked.status, 409); checks.push('Workbench respects manually opened Browser profiles');
  await runtime.close(); runtime = undefined; await workbench.close(); workbench = undefined; await client.close();
  assert.equal((await client.listProfiles()).find(profile => profile.id === manual.id).state, 'running');
  await client.stop(manual.id); checks.push('Closing Workbench preserves independently opened Browser windows');
  const output = resolve('test-results/vesper-pair'); await mkdir(output, { recursive: true });
  const result = { result: 'passed', browser: 'Vesper Browser', workbench: 'Vesper Workbench', author: 'true-utopian', archiveBytes: archive.length, checks };
  await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
} finally {
  await runtime?.close(); await workbench?.close(); await client?.close();
  if (manager) await new Promise((done, reject) => manager.close(error => error ? reject(error) : done()));
  await browser.close();
  const target = resolve(directory), temporaryRoot = resolve(tmpdir());
  assert.ok(target.startsWith(temporaryRoot + '\\') || target.startsWith(temporaryRoot + '/'));
  await rm(target, { recursive: true, force: true });
}
