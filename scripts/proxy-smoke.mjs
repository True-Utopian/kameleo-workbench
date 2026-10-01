import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { connect, isIP } from 'node:net';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Runtime } from '../dist/runtime.js';
import { ProxyManager } from '../dist/proxies/index.js';
import { KameleoEngine } from '../dist/engine.js';
import { KameleoLocalApiClient } from '@kameleo/local-api-client';

// Explicit integration smoke test: run only with no other active browser runs.
// In Compose: docker compose exec workbench node scripts/proxy-smoke.mjs
// Native: set SMOKE_PROXY_HOST=127.0.0.1, DEMO_URL, KAMELEO_URL and the export path mapping.
// This temporary relay is authenticated, origin-restricted and never mapped by Compose.

const engineUrl = process.env.KAMELEO_URL ?? 'http://kameleo:5050';
const demoUrl = new URL(process.env.DEMO_URL ?? 'http://workbench:3180/demo');
const probeUrl = new URL(process.env.SMOKE_PROBE_URL ?? 'https://api.ipify.org?format=json');
const proxyHost = process.env.SMOKE_PROXY_HOST ?? 'workbench';
const proxyBind = process.env.SMOKE_PROXY_BIND ?? '0.0.0.0';
const proxyPort = Number(process.env.SMOKE_PROXY_PORT ?? 39180);
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 600_000);
assert.ok(Number.isInteger(proxyPort) && proxyPort >= 1 && proxyPort <= 65535, 'Invalid SMOKE_PROXY_PORT');
assert.ok(Number.isInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 900_000, 'Invalid SMOKE_TIMEOUT_MS');
assert.ok(['http:', 'https:'].includes(demoUrl.protocol) && !demoUrl.username && !demoUrl.password, 'DEMO_URL must be a credential-free HTTP(S) URL');
assert.ok(probeUrl.protocol === 'https:' && !probeUrl.username && !probeUrl.password, 'SMOKE_PROBE_URL must be a credential-free HTTPS URL returning {ip}');
const localExportDir = path.resolve(process.env.EXPORT_DIR ?? (process.platform === 'win32' ? 'profiles' : '/exports'));
const engineExportDir = process.env.KAMELEO_EXPORT_DIR ?? localExportDir;
const relayUsername = `smoke-${randomBytes(8).toString('hex')}`;
const relayPassword = randomBytes(24).toString('base64url');
const expectedAuthorization = Buffer.from(`Basic ${Buffer.from(`${relayUsername}:${relayPassword}`).toString('base64')}`);
const nonce = randomBytes(16).toString('hex');
demoUrl.searchParams.set('proxySmoke', nonce);
const stats = { httpRequests: 0, connectRequests: 0, demoRequests: 0, probeConnectRequests: 0, deniedRequests: 0, deniedTargets: {} };
const sockets = new Set();
const upstreamRequests = new Set();
const connectionTtlMs = 30_000;
const hostKey = (hostname, port) => `${hostname.replace(/^\[|\]$/g, '').toLowerCase()}:${port}`;
const originKey = url => hostKey(url.hostname, url.port || (url.protocol === 'https:' ? 443 : 80));
// These exact Kameleo IP-location service hosts were observed on startup in the pinned Engine.
// https://help.kameleo.io/article/65-kameleo-in-restricted-network-environments
const allowedTargets = new Set([originKey(demoUrl), originKey(probeUrl), 'tools.kameleo.io:443', 'tools-bckp4.kameleo.io:443']);
let runtime;
let runId;
let temporaryDirectory;
let relayListening = false;
let runtimeClosed = false;

function authenticated(request) {
  const value = request.headers['proxy-authorization'];
  if (typeof value !== 'string') return false;
  const candidate = Buffer.from(value);
  return candidate.length === expectedAuthorization.length && timingSafeEqual(candidate, expectedAuthorization);
}
function track(socket) {
  sockets.add(socket);
  const timer = setTimeout(() => socket.destroy(), connectionTtlMs);
  timer.unref();
  socket.on('error', () => {});
  socket.once('close', () => { clearTimeout(timer); sockets.delete(socket); });
  return socket;
}
function filteredHeaders(headers) {
  const result = { ...headers };
  const connectionHeaders = String(headers.connection ?? '').split(',').map(value => value.trim().toLowerCase());
  for (const header of ['connection', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade', ...connectionHeaders]) delete result[header];
  return result;
}
function rejectHttp(response, status) {
  stats.deniedRequests++;
  response.writeHead(status, { connection: 'close', ...(status === 407 ? { 'proxy-authenticate': 'Basic realm="Workbench smoke test"' } : {}) });
  response.end('Proxy request rejected.');
}
function recordDeniedTarget(target) {
  // Record only parsed host:port, never URL paths, query strings, headers or credentials.
  const key = originKey(target);
  if (Object.keys(stats.deniedTargets).length < 40 || Object.hasOwn(stats.deniedTargets, key)) stats.deniedTargets[key] = (stats.deniedTargets[key] ?? 0) + 1;
}

const relay = createServer((request, response) => {
  if (!authenticated(request)) { rejectHttp(response, 407); return; }
  let target;
  try { target = new URL(request.url); } catch { rejectHttp(response, 400); return; }
  if (target.protocol !== 'http:' || target.username || target.password || !allowedTargets.has(originKey(target))) { recordDeniedTarget(target); rejectHttp(response, 403); return; }
  stats.httpRequests++;
  if (originKey(target) === originKey(demoUrl) && target.pathname === demoUrl.pathname && target.searchParams.get('proxySmoke') === nonce) stats.demoRequests++;
  const upstream = httpRequest(target, {
    method: request.method,
    headers: { ...filteredHeaders(request.headers), host: target.host, connection: 'close' },
    signal: AbortSignal.timeout(connectionTtlMs),
  }, upstreamResponse => {
    response.writeHead(upstreamResponse.statusCode ?? 502, filteredHeaders(upstreamResponse.headers));
    upstreamResponse.pipe(response);
    upstreamResponse.on('error', () => response.destroy());
  });
  upstreamRequests.add(upstream);
  upstream.once('close', () => upstreamRequests.delete(upstream));
  upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
  request.on('aborted', () => upstream.destroy());
  request.on('error', () => upstream.destroy());
  response.on('close', () => { if (!response.writableFinished) upstream.destroy(); });
  request.pipe(upstream);
});
relay.maxConnections = 64;
relay.headersTimeout = 10_000;
relay.requestTimeout = connectionTtlMs;
relay.keepAliveTimeout = 1000;
relay.on('connection', track);
relay.on('clientError', (_error, socket) => socket.destroy());
relay.on('connect', (request, client, head) => {
  if (!authenticated(request)) {
    stats.deniedRequests++;
    client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="Workbench smoke test"\r\nConnection: close\r\n\r\n');
    return;
  }
  let target;
  try { target = new URL(`https://${request.url}`); } catch { client.destroy(); return; }
  const port = Number(target.port || 443);
  if (target.username || target.password || target.pathname !== '/' || target.search || target.hash || !allowedTargets.has(hostKey(target.hostname, port))) {
    recordDeniedTarget(target); stats.deniedRequests++; client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
  }
  stats.connectRequests++;
  if (hostKey(target.hostname, port) === originKey(probeUrl)) stats.probeConnectRequests++;
  const upstream = track(connect({ host: target.hostname.replace(/^\[|\]$/g, ''), port }));
  upstream.once('connect', () => {
    if (client.destroyed) { upstream.destroy(); return; }
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) upstream.write(head);
    client.pipe(upstream); upstream.pipe(client);
  });
  upstream.on('error', () => client.destroy());
  upstream.on('close', () => client.destroy());
  client.on('error', () => upstream.destroy());
  client.on('close', () => upstream.destroy());
});

async function bounded(operation, duration, label) {
  let timer;
  try { return await Promise.race([operation, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out.`)), duration); })]); }
  finally { clearTimeout(timer); }
}
async function removeOwnTemporaryDirectory() {
  if (!temporaryDirectory) return;
  const resolvedTemporary = path.resolve(temporaryDirectory);
  const relative = path.relative(path.resolve(tmpdir()), resolvedTemporary);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(resolvedTemporary).startsWith('workbench-proxy-smoke-'), 'Refusing to remove an unexpected temporary path');
  await rm(resolvedTemporary, { recursive: true, force: true });
}

try {
  await new Promise((resolveListen, reject) => {
    relay.once('error', reject);
    relay.listen(proxyPort, proxyBind, () => { relay.removeListener('error', reject); resolveListen(); });
  });
  relayListening = true;
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'workbench-proxy-smoke-'));
  const automationsDir = path.join(temporaryDirectory, 'automations');
  await mkdir(automationsDir);
  await mkdir(localExportDir, { recursive: true });
  // The generated module contains no credentials or server-specific paths and imports no outside files.
  await writeFile(path.join(automationsDir, 'proxy-smoke.mjs'), `export default {
    id: 'proxy-smoke', title: 'Private proxy smoke test', preset: 'fast',
    inputSchema: {type:'object', required:['demoUrl','probeUrl','message'], additionalProperties:false,
      properties:{demoUrl:{type:'string'},probeUrl:{type:'string'},message:{type:'string'}}},
    async run({inputs,page,actions,log,done}) {
      await actions.goto(inputs.probeUrl);
      const observed = await page.evaluate(() => JSON.parse(document.body.innerText).ip);
      if (typeof observed !== 'string') throw new Error('Probe did not return an IP');
      log(JSON.stringify({kind:'proxy-smoke-browser-ip',ip:observed}));
      await actions.goto(inputs.demoUrl);
      await actions.fill('[data-test="message"]', inputs.message);
      await actions.click('[data-test="save"]');
      await page.waitForFunction(expected => document.querySelector('[data-test="saved"]')?.textContent === expected, {}, inputs.message);
      log('The proxied demo form completed.');
      await done();
    }
  };\n`, { mode: 0o600 });
  const proxies = new ProxyManager({
    inventoryFile: path.join(temporaryDirectory, 'unused-inventory.json'),
    probeOptions: { url: probeUrl.href },
  });
  const engine = new KameleoEngine(engineUrl);
  const client = new KameleoLocalApiClient({ basePath: engineUrl });
  // Runtime stops the new test browser before calling export. Do not preserve its one-use credentials.
  engine.export = async (profileId, exportPath) => {
    await client.profile.updateProfile(profileId, { proxy: { value: 'none' } });
    await client.profile.exportProfile(profileId, { path: exportPath });
  };
  runtime = new Runtime({
    engineUrl, dataDir: path.join(temporaryDirectory, 'state'), automationsDir,
    localExportDir, engineExportDir, maxConcurrency: 1, runTimeoutMs: timeoutMs,
    cleanupTimeoutMs: 15_000, proxies, engine,
    defaultProxyRequest: { provider: 'direct', maxAttempts: 1, timeoutMs: 20_000, probeTimeoutMs: 15_000,
      proxy: { protocol: 'http', host: proxyHost, port: proxyPort, username: relayUsername, password: relayPassword } },
  });
  await runtime.init();
  const started = Date.now();
  let run = await runtime.submit({ automationId: 'proxy-smoke', preset: 'fast', inputs: { demoUrl: demoUrl.href, probeUrl: probeUrl.href, message: 'Headed Kameleo proxy smoke test' } });
  runId = run.id;
  console.log(`Proxy smoke run ${runId} started.`);
  const deadline = Date.now() + timeoutMs + 30_000;
  const terminal = new Set(['saved', 'failed', 'cancelled', 'interrupted', 'export_failed']);
  while (!terminal.has(run.state)) {
    if (Date.now() > deadline) throw new Error('Proxy smoke run exceeded its completion deadline.');
    await delay(500); run = runtime.get(runId);
  }
  assert.equal(run.state, 'saved', `Proxy smoke ended in ${run.state}: ${run.error ?? 'no error detail'}`);
  await bounded(runtime.close(), 20_000, 'Runtime cleanup');
  runtimeClosed = true;
  run = runtime.get(runId);
  assert.equal(run.cleanupRequired, false, 'Browser cleanup was not confirmed');
  const probeIp = run.proxy?.verified?.exitIp;
  const browserEntry = run.logs.map(entry => {
    try { return JSON.parse(entry.message); } catch { return undefined; }
  }).find(entry => entry?.kind === 'proxy-smoke-browser-ip');
  assert.ok(isIP(probeIp ?? ''), 'Proxy manager did not verify an exit IP');
  assert.equal(browserEntry?.ip, probeIp, 'Browser exit IP differs from the manager probe');
  assert.ok(stats.probeConnectRequests >= 2, 'Expected both manager and browser HTTPS probe traffic through the relay');
  if (demoUrl.protocol === 'http:') assert.ok(stats.demoRequests >= 1, 'Browser demo request bypassed the HTTP relay');
  else assert.ok(stats.connectRequests >= 3, 'Browser demo request did not establish its HTTPS proxy tunnel');
  const archive = await readFile(run.artifact.path);
  assert.ok(archive.length > 0 && archive.length === run.artifact.bytes, 'Archive size is invalid');
  assert.equal(createHash('sha256').update(archive).digest('hex'), run.artifact.sha256, 'Archive checksum mismatch');
  console.log(JSON.stringify({
    runId, profileId: run.profileId, state: run.state, proxyVerified: true,
    managerExitIp: probeIp, browserExitIp: browserEntry.ip, relay: stats,
    archive: { path: run.artifact.path, bytes: run.artifact.bytes, sha256: run.artifact.sha256 },
    elapsedMs: Date.now() - started,
    note: 'Stopped test profile and archive retained; temporary proxy credentials were removed before export.',
  }, null, 2));
} catch (error) {
  // Network/library exceptions can contain credentials: emit only locally authored assertion text or a generic failure.
  const message = error instanceof assert.AssertionError ? error.message : 'Proxy smoke test failed; inspect Engine connectivity and the disposable run state.';
  console.error(JSON.stringify({ error: message, ...(runId ? { runId } : {}), relay: stats }));
  process.exitCode = 1;
} finally {
  if (runtime && !runtimeClosed) {
    try { await bounded(runtime.close(), 20_000, 'Runtime cleanup'); runtimeClosed = true; }
    catch { console.error('Runtime cleanup remains uncertain. Inspect the disposable profile before another test.'); process.exitCode = 1; }
  }
  for (const request of upstreamRequests) request.destroy();
  for (const socket of sockets) socket.destroy();
  if (relayListening) await bounded(new Promise(resolveClose => relay.close(() => resolveClose())), 5000, 'Relay cleanup').catch(() => { process.exitCode = 1; });
  const cleanupRequired = runtime && runId ? runtime.get(runId).cleanupRequired : false;
  if ((!runtime || runtimeClosed) && !cleanupRequired && !process.exitCode) await removeOwnTemporaryDirectory();
  else if (temporaryDirectory) console.error(`Temporary recovery records retained at ${temporaryDirectory}`);
}
