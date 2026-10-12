import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import net from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';
import { Server as ProxyServer } from 'proxy-chain';
import { LocalEngine } from '../dist/local-engine.js';
import { Runtime } from '../dist/runtime.js';
import { createServer } from '../dist/server.js';
import { loadConfig } from '../dist/config.js';

const started = performance.now();
const directory = await mkdtemp(join(tmpdir(), 'workbench-chromium-smoke-'));
const executablePath = process.env.LOCAL_BROWSER_EXECUTABLE || JSON.parse(await readFile(resolve('.workbench/local-engine/browser.json'), 'utf8')).executablePath;
const headless = process.env.LOCAL_SMOKE_HEADLESS !== 'false';
const engine = new LocalEngine({ directory: join(directory, 'engine'), executablePath, headless, maxConcurrency: 3 });
const token = 'local-browser-smoke-access-token-no-live-secrets';
const config = await loadConfig({ WORKBENCH_DATA_DIR: join(directory, 'runs'), WORKBENCH_TOKEN: token, EXPORT_DIR: join(directory, 'exports'), MAX_CONCURRENCY: '1' });
const runtime = new Runtime({ ...config, engine });
let app, httpProxy, socksProxy, origin;
const connected = new Set();
const socksSockets = new Set();
const measurements = {};
async function attach(id) { const browser = await puppeteer.connect({ browserWSEndpoint: await engine.connectionUrl(id), defaultViewport: null }); connected.add(browser); return { browser, page: (await browser.pages())[0] }; }
async function until(id, check) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const record = runtime.get(id);
    if (check(record)) return record;
    if (['failed', 'cancelled', 'interrupted', 'export_failed'].includes(record.state)) throw new Error(`Local smoke run failed: ${JSON.stringify(record)}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Local smoke exceeded run deadline');
}
async function startTimed(id, label) { const start = performance.now(); await engine.start(id); measurements[label] = Math.round(performance.now() - start); }

try {
  await engine.ready(); await runtime.init();
  app = await createServer(config, runtime, { publicInventory: () => [] }, engine);
  app.get('/local-smoke-state', async (request, reply) => {
    if (request.query.set) reply.setCookie('persistent', 'profile-one', { path: '/', maxAge: 3600 });
    return reply.type('text/html').send('<!doctype html><title>Local storage fixture</title><h1>Owned test page</h1>');
  });
  origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const p1 = await engine.create({ name: 'Persistence fixture', locale: 'en-GB', timezone: 'Europe/London', viewport: { width: 1024, height: 768 } });
  const p2 = await engine.create({ name: 'Isolation fixture' });
  await startTimed(p1.id, 'coldStartMs');
  let owner = await attach(p1.id);
  await owner.page.goto(`${origin}/local-smoke-state?set=1`);
  await owner.page.evaluate(() => localStorage.setItem('persisted', 'profile-one'));
  assert.equal(await owner.page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone), 'Europe/London');
  assert.equal(await owner.page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().locale), 'en-GB');
  await engine.start(p2.id);
  const isolated = await attach(p2.id); await isolated.page.goto(`${origin}/local-smoke-state`);
  assert.equal(await isolated.page.evaluate(() => localStorage.getItem('persisted')), null);
  assert.equal(await isolated.page.evaluate(() => document.cookie.includes('persistent=')), false);
  await engine.stop(p2.id); await engine.stop(p1.id);
  const archive = join(directory, 'roundtrip.workbench.tgz');
  const exporting = performance.now(); await engine.export(p1.id, archive); measurements.exportMs = Math.round(performance.now() - exporting);
  await startTimed(p1.id, 'warmStartMs'); owner = await attach(p1.id); await owner.page.goto(`${origin}/local-smoke-state`);
  assert.equal(await owner.page.evaluate(() => localStorage.getItem('persisted')), 'profile-one');
  assert.equal(await owner.page.evaluate(() => document.cookie.includes('persistent=profile-one')), true);
  await engine.stop(p1.id);
  const restored = await engine.importProfile(archive); await engine.start(restored.id);
  const restore = await attach(restored.id); await restore.page.goto(`${origin}/local-smoke-state`);
  assert.equal(await restore.page.evaluate(() => localStorage.getItem('persisted')), 'profile-one');
  assert.equal(await restore.page.evaluate(() => document.cookie.includes('persistent=profile-one')), true);
  await engine.stop(restored.id);

  const recoveryDir = join(directory, 'recovery-engine');
  const recoveryScript = join(directory, 'recovery-child.mjs');
  await writeFile(recoveryScript, `import { LocalEngine } from ${JSON.stringify(pathToFileURL(resolve('dist/local-engine.js')).href)}; const engine = new LocalEngine(${JSON.stringify({ directory: recoveryDir, executablePath, headless })}); await engine.ready(); const profile = await engine.create({ name: 'Crash recovery fixture' }); await engine.start(profile.id); process.send({ id: profile.id }); setInterval(() => {}, 1000);`);
  const child = spawn(process.execPath, [recoveryScript], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  let childId;
  try {
    childId = await new Promise((resolveChild, reject) => {
      const timer = setTimeout(() => reject(new Error('Recovery child did not start')), 30_000);
      child.once('message', message => { clearTimeout(timer); resolveChild(message.id); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Recovery child exited before readiness')); });
    });
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    const recoveredEngine = new LocalEngine({ directory: recoveryDir, executablePath, headless });
    try { await recoveredEngine.ready(); await recoveredEngine.stop(childId); assert.equal((await recoveredEngine.listProfiles())[0].state, 'stopped'); await recoveredEngine.export(childId, join(directory, 'recovered.workbench.tgz')); }
    finally { await recoveredEngine.close(); }
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }

  let proxyHits = 0;
  const fixturePort = Number(new URL(origin).port);
  httpProxy = new ProxyServer({ host: '127.0.0.1', port: 0, prepareRequestFunction: ({ hostname, port, username, password }) => {
    const allowed = hostname === '127.0.0.1' && port === fixturePort && username === 'smoke-user' && password === 'smoke@password';
    if (allowed) proxyHits++;
    return { requestAuthentication: !allowed };
  } });
  await httpProxy.listen();
  const proxied = await engine.create({ name: 'HTTP proxy fixture', proxy: { value: 'http', extra: { host: '127.0.0.1', port: httpProxy.port, id: 'smoke-user', secret: 'smoke@password' } } });
  await engine.start(proxied.id); const viaProxy = await attach(proxied.id);
  await viaProxy.page.goto(`${origin}/local-smoke-state`); assert.ok(proxyHits > 0, 'Authenticated HTTP proxy did not forward the fixture request');
  assert.equal(await viaProxy.page.$eval('h1', element => element.textContent), 'Owned test page');
  await engine.stop(proxied.id);

  let socksHits = 0;
  socksProxy = net.createServer(socket => {
    socksSockets.add(socket); socket.on('close', () => socksSockets.delete(socket)); socket.on('error', () => {});
    let state = 'greeting', buffer = Buffer.alloc(0);
    const read = chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (state === 'greeting') {
        if (buffer.length < 2 + buffer[1]) return;
        assert.equal(buffer[0], 5); assert.ok(buffer.subarray(2, 2 + buffer[1]).includes(2));
        buffer = buffer.subarray(2 + buffer[1]); socket.write(Buffer.from([5, 2])); state = 'auth';
      }
      if (state === 'auth') {
        if (buffer.length < 2) return; const ulen = buffer[1];
        if (buffer.length < 3 + ulen) return; const plen = buffer[2 + ulen];
        if (buffer.length < 3 + ulen + plen) return;
        assert.equal(buffer.subarray(2, 2 + ulen).toString(), 'socks-user');
        assert.equal(buffer.subarray(3 + ulen, 3 + ulen + plen).toString(), 'socks-password');
        buffer = buffer.subarray(3 + ulen + plen); socket.write(Buffer.from([1, 0])); state = 'connect';
      }
      if (state === 'connect') {
        if (buffer.length < 5) return;
        const length = buffer[3] === 1 ? 4 : buffer[3] === 3 ? 1 + buffer[4] : 16;
        if (buffer.length < 6 + length) return;
        const host = buffer[3] === 1 ? [...buffer.subarray(4, 8)].join('.') : buffer.subarray(5, 4 + length).toString();
        const port = buffer.readUInt16BE(4 + length);
        if (host !== '127.0.0.1' || port !== fixturePort) { socket.destroy(); return; }
        socksHits++; state = 'piping'; socket.removeListener('data', read);
        const upstream = net.connect(port, host); socksSockets.add(upstream); upstream.on('close', () => socksSockets.delete(upstream));
        upstream.on('error', () => socket.destroy()); socket.on('close', () => upstream.destroy()); upstream.on('close', () => socket.destroy());
        upstream.once('connect', () => { socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0])); const pending = buffer.subarray(6 + length); if (pending.length) upstream.write(pending); socket.pipe(upstream); upstream.pipe(socket); });
      }
    };
    socket.on('data', read);
  });
  socksProxy.listen(0, '127.0.0.1'); await once(socksProxy, 'listening');
  const socks = await engine.create({ name: 'SOCKS5 proxy fixture', proxy: { value: 'socks5', extra: { host: '127.0.0.1', port: socksProxy.address().port, id: 'socks-user', secret: 'socks-password' } } });
  await engine.start(socks.id); const viaSocks = await attach(socks.id); await viaSocks.page.goto(`${origin}/local-smoke-state`);
  assert.ok(socksHits > 0, 'Browser bypassed the authenticated SOCKS5 proxy'); await engine.stop(socks.id);

  const demo = await runtime.submit({ automationId: 'demo', inputs: { url: `${origin}/demo`, message: 'Local backend full run' }, preset: 'fast' });
  const saved = await until(demo.id, r => r.state === 'saved');
  assert.match(saved.artifact.name, /\.workbench\.tgz$/);
  const artifact = await readFile(saved.artifact.path);
  assert.equal(createHash('sha256').update(artifact).digest('hex'), saved.artifact.sha256);
  const download = await fetch(`${origin}/api/runs/${demo.id}/artifact`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(download.status, 200); assert.deepEqual(Buffer.from(await download.arrayBuffer()), artifact);

  const inspection = await runtime.submit({ automationId: 'inspect', inputs: { url: `${origin}/demo` }, preset: 'fast' });
  await until(inspection.id, r => r.waitingForFinish);
  const screenshot = await runtime.screenshot(inspection.id); assert.equal(screenshot.subarray(0, 2).toString('hex'), 'ffd8');
  await runtime.done(inspection.id); await until(inspection.id, r => r.state === 'saved');

  const ui = await engine.create({ name: 'Dashboard UI fixture' }); await engine.start(ui.id); const dashboard = await attach(ui.id);
  const errors = []; dashboard.page.on('pageerror', e => errors.push(e.message));
  await dashboard.page.setViewport({ width: 1440, height: 960 });
  await dashboard.page.goto(origin); await dashboard.page.type('#access-token', token); await dashboard.page.click('#login-button');
  await dashboard.page.waitForFunction(() => !document.getElementById('workspace').hidden && !document.getElementById('profiles-button').hidden);
  await dashboard.page.click('#profiles-button'); await dashboard.page.waitForSelector('.local-profile-row');
  await dashboard.page.type('#profile-name', 'Created in dashboard'); await dashboard.page.click('#profile-form button[type=submit]');
  await dashboard.page.waitForFunction(() => document.getElementById('local-profiles-list').textContent.includes('Created in dashboard'));
  // Exercise streaming imports through the authenticated browser session.
  const importedResponse = await fetch(`${origin}/api/local-profiles/import`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/gzip' }, body: await readFile(archive) });
  assert.equal(importedResponse.status, 201); const uploaded = await importedResponse.json();
  const changed = await fetch(`${origin}/api/local-profiles/${uploaded.id}`, { method: 'PATCH', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Edited imported profile', proxy: null }) });
  assert.equal(changed.status, 200);
  const output = resolve('test-results/local-browser'); await mkdir(output, { recursive: true });
  await dashboard.page.screenshot({ path: join(output, 'profiles-desktop.png'), fullPage: true });
  await dashboard.page.setViewport({ width: 390, height: 844 });
  assert.equal(await dashboard.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await dashboard.page.screenshot({ path: join(output, 'profiles-mobile.png'), fullPage: true });
  assert.deepEqual(errors, []); await engine.stop(ui.id);
  const result = { passed: true, headless, checks: ['profile isolation', 'persistent cookies and storage', 'timezone and locale', 'archive restore', 'process-crash recovery', 'authenticated HTTP proxy', 'authenticated SOCKS5 proxy', 'real automation worker', 'SHA-256 download', 'browser snapshot', 'dashboard profile creation', 'streaming HTTP archive import', 'profile editing', 'mobile layout', 'confirmed browser shutdown'], ...measurements, totalMs: Math.round(performance.now() - started), archiveBytes: artifact.length };
  await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2));
  await writeFile(join(output, headless ? 'result-headless.json' : 'result-headed.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await runtime.close();
  for (const browser of connected) await browser.disconnect().catch(() => {});
  await engine.close(); await app?.close(); await httpProxy?.close(true);
  for (const socket of socksSockets) socket.destroy();
  if (socksProxy) await new Promise(resolve => socksProxy.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
