import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import puppeteer from 'puppeteer-core';
import { VesperBrowser } from '@true-utopian/vesper-browser';

// Controlled, owned origins only. This records exposed attributes rather than
// equating browser settings with coherent fingerprint masking.
const snapshot = () => ({
  userAgent: navigator.userAgent,
  language: navigator.language,
  languages: [...navigator.languages],
  platform: navigator.platform,
  hardwareConcurrency: navigator.hardwareConcurrency,
  deviceMemory: navigator.deviceMemory ?? null,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  locale: Intl.DateTimeFormat().resolvedOptions().locale,
  webdriver: navigator.webdriver ?? null,
  viewport: typeof window === 'undefined' ? null : { width: innerWidth, height: innerHeight },
  screen: typeof screen === 'undefined' ? null : { width: screen.width, height: screen.height, pixelRatio: devicePixelRatio },
});
const script = `(${snapshot.toString()})()`;
const requests = [];
let blockedOriginHits = 0;
const origin = createServer((request, response) => {
  const route = new URL(request.url, 'http://fixture.local').pathname;
  requests.push({ route, acceptLanguage: request.headers['accept-language'] ?? null, userAgent: request.headers['user-agent'] ?? null });
  if (route === '/blocked-origin') { blockedOriginHits++; response.end('This must not load through an unavailable proxy'); return; }
  if (route === '/worker.js') { response.setHeader('Content-Type', 'application/javascript'); response.end(`postMessage(${script})`); return; }
  response.setHeader('Content-Type', 'text/html');
  response.end(`<!doctype html><meta charset="utf-8"><title>Vesper browser observation fixture</title><script>window.initialObservation=${script};</script><h1>Controlled browser fixture</h1>${route === '/main' ? `<iframe src="/frame"></iframe><iframe src="http://localhost:${origin.address().port}/cross-frame"></iframe>` : ''}`);
});
await new Promise(done => origin.listen(0, '127.0.0.1', done));
const address = `http://127.0.0.1:${origin.address().port}`;
const directory = await mkdtemp(join(tmpdir(), 'vesper-observations-'));
const output = resolve('test-results/vesper-browser');
const executablePath = process.env.LOCAL_BROWSER_EXECUTABLE || JSON.parse(await readFile(resolve('.workbench/local-engine/browser.json'), 'utf8')).executablePath;
const browser = new VesperBrowser({ directory: join(directory, 'store'), executablePath, headless: true, maxConcurrency: 2 });
const connections = [];
const result = {
  product: 'Vesper Browser', author: 'true-utopian', observedAt: new Date().toISOString(),
  scope: 'Same-machine synthetic fixture; no OS packet capture or vendor comparison.',
  requestedSettings: { locale: 'fr-FR', timezone: 'America/New_York', viewport: { width: 1200, height: 800 } },
  environments: {}, findings: [], checks: [], measurements: {},
};
async function attach(id) {
  const connection = await puppeteer.connect({ browserWSEndpoint: await browser.connectionUrl(id), defaultViewport: null });
  connections.push(connection);
  return { connection, page: (await connection.pages())[0] };
}
try {
  await browser.ready();
  const configured = await browser.create({ name: 'Environment fixture', ...result.requestedSettings });
  const isolated = await browser.create({ name: 'Isolation fixture' });
  let start = performance.now(); await browser.start(configured.id); result.measurements.coldStartMs = Math.round(performance.now() - start);
  let owner = await attach(configured.id);
  result.browserVersion = await owner.connection.version();
  await owner.page.goto(`${address}/main`);
  result.environments.mainInitial = await owner.page.evaluate(() => window.initialObservation);
  assert.equal(result.environments.mainInitial.timezone, result.requestedSettings.timezone);
  assert.equal(result.environments.mainInitial.locale, result.requestedSettings.locale);
  const child = owner.page.frames().find(frame => frame.url() === `${address}/frame`);
  assert.ok(child, 'Fixture frame is loaded');
  result.environments.frameInitial = await child.evaluate(() => window.initialObservation);
  const crossChild = owner.page.frames().find(frame => frame.url().endsWith('/cross-frame'));
  assert.ok(crossChild, 'Cross-origin fixture frame is loaded');
  result.environments.crossOriginFrameInitial = await crossChild.evaluate(() => window.initialObservation);
  assert.equal(result.environments.crossOriginFrameInitial.timezone, result.requestedSettings.timezone);
  assert.equal(result.environments.crossOriginFrameInitial.locale, result.requestedSettings.locale);
  result.checks.push('Cross-origin iframe locale/timezone applied before its first fixture script');
  result.environments.workerInitial = await owner.page.evaluate(() => new Promise((done, reject) => {
    const worker = new Worker('/worker.js');
    worker.onmessage = event => { worker.terminate(); done(event.data); };
    worker.onerror = error => { worker.terminate(); reject(new Error(error.message)); };
  }));
  const popupTarget = owner.connection.waitForTarget(target => target.url() === `${address}/popup`);
  await owner.page.evaluate(url => window.open(url, '_blank'), `${address}/popup`);
  const popup = await (await popupTarget).page();
  await popup.waitForFunction(() => window.initialObservation);
  result.environments.popupInitial = await popup.evaluate(() => window.initialObservation);
  result.environments.popupCurrent = await popup.evaluate(snapshot);
  await owner.page.evaluate(() => { localStorage.setItem('vesper-isolation', 'first-profile'); document.cookie = 'vesperIsolation=first-profile; path=/; max-age=3600'; });
  await browser.start(isolated.id);
  const other = await attach(isolated.id); await other.page.goto(`${address}/isolation`);
  assert.deepEqual(await other.page.evaluate(() => ({ storage: localStorage.getItem('vesper-isolation'), cookie: document.cookie.includes('vesperIsolation=') })), { storage: null, cookie: false });
  result.checks.push('Main page locale/timezone applied before fixture script', 'Cookie and localStorage separation between profiles');
  await browser.stop(isolated.id); await browser.stop(configured.id);
  start = performance.now(); await browser.start(configured.id); result.measurements.warmStartMs = Math.round(performance.now() - start);
  owner = await attach(configured.id); await owner.page.goto(`${address}/persistence`);
  assert.deepEqual(await owner.page.evaluate(() => ({ storage: localStorage.getItem('vesper-isolation'), cookie: document.cookie.includes('vesperIsolation=first-profile') })), { storage: 'first-profile', cookie: true });
  result.checks.push('Cookie and localStorage persistence after restart');
  await browser.stop(configured.id);

  // Reserve then release a local port to construct a known unavailable proxy.
  const reservation = createTcpServer(); await new Promise(done => reservation.listen(0, '127.0.0.1', done));
  const unavailablePort = reservation.address().port; await new Promise(done => reservation.close(done));
  const proxied = await browser.create({ name: 'Unavailable proxy fixture', proxy: { value: 'http', extra: { host: '127.0.0.1', port: unavailablePort } } });
  await browser.start(proxied.id); const routed = await attach(proxied.id);
  let failureResponse, failureError;
  try { failureResponse = await routed.page.goto(`${address}/blocked-origin`, { timeout: 10000 }); }
  catch (error) { failureError = error.message; }
  assert.ok(failureError || (failureResponse && failureResponse.status() >= 500), 'Unavailable proxy must return a network failure or proxy error response');
  result.unavailableProxy = { status: failureResponse?.status() ?? null, navigationError: failureError ?? null };
  assert.equal(blockedOriginHits, 0);
  result.checks.push('Unavailable upstream proxy prevents direct HTTP fallback to controlled origin');
  await browser.stop(proxied.id);

  for (const [context, attributes] of Object.entries(result.environments)) {
    for (const field of ['timezone', 'locale', 'language']) {
      const expected = field === 'timezone' ? result.requestedSettings.timezone : result.requestedSettings.locale;
      if (attributes[field] !== expected) result.findings.push({ context, field, expected, observed: attributes[field] });
    }
  }
  result.limitations = [
    'Standard Chromium still exposes its real browser/platform/hardware attributes and automation state.',
    'Viewport configuration does not synthesize a coherent screen/device persona.',
    'One cross-origin frame and dedicated worker do not prove service-worker or every popup race coverage.',
    'Controlled HTTP fallback check does not prove absence of DNS, UDP, WebRTC or OS-level leaks.',
  ];
  result.requests = requests;
  result.state = 'passed';
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'observations.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ state: result.state, checks: result.checks, findings: result.findings, measurements: result.measurements, output: join(output, 'observations.json') }, null, 2));
} catch (error) {
  result.state = 'failed'; result.error = error.message;
  await mkdir(output, { recursive: true }); await writeFile(join(output, 'observations.json'), JSON.stringify(result, null, 2));
  throw error;
} finally {
  for (const connection of connections) await connection.disconnect().catch(() => {});
  await browser.close(); await new Promise(done => origin.close(done));
  await rm(directory, { recursive: true, force: true });
}
