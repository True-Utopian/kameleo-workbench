import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';
import { VesperBrowser, VesperBrowserClient, browserAccessToken, createBrowserServer } from '@true-utopian/vesper-browser';
import { Runtime } from '../dist/runtime.js';

// Original fixtures, temporary stores and loopback services only. This suite
// measures upstream-native/CDP behavior; it does not qualify a custom kernel.
const output = resolve('test-results/native-engine');
const directory = await mkdtemp(join(tmpdir(), 'vesper-native-qualification-'));
const chromium = JSON.parse(await readFile('.workbench/local-engine/browser.json', 'utf8'));
const brave = JSON.parse(await readFile('test-results/expansion/native-data/browser/selected-brave.json', 'utf8'));
const policy = { locale: 'fr-FR', timezone: 'America/New_York', environment: { hardwareConcurrency: 4, screen: { width: 1366, height: 768, deviceScaleFactor: 1 } } };
const report = { at: new Date().toISOString(), author: 'true-utopian', implementation: 'upstream-native-engines-and-cdp', customCompiledKernel: false, scope: 'Owned loopback origins and fresh temporary stores. No vendor binary, user profile, app service or OS networking changes.', requested: policy, engines: { chromium: { executablePath: chromium.executablePath, executableSha256: createHash('sha256').update(await readFile(chromium.executablePath)).digest('hex') }, brave: { executablePath: brave.executablePath, executableSha256: createHash('sha256').update(await readFile(brave.executablePath)).digest('hex'), buildId: brave.buildId } }, cases: [], checks: [], failures: [], limitations: ['Native privacy observations on this fixture do not prove detection bypass, arbitrary device personas or every-site consistency.', 'Headed cross-process frame display metrics remain native; workers have no screen API.', 'No packet capture or network leak qualification is performed.'] };

function sample() {
  const canvas = typeof document === 'undefined' ? new OffscreenCanvas(160, 48) : document.createElement('canvas');
  canvas.width = 160; canvas.height = 48;
  const context = canvas.getContext('2d');
  context.fillStyle = '#cd4567'; context.fillRect(3, 2, 155, 43);
  context.font = '16px Arial'; context.fillStyle = '#324578'; context.fillText('Vesper / true-utopian', 4, 27);
  return { cpu: navigator.hardwareConcurrency, language: navigator.language, languages: [...navigator.languages], locale: Intl.DateTimeFormat().resolvedOptions().locale, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, screen: typeof screen === 'undefined' ? null : { width: screen.width, height: screen.height, pixelRatio: devicePixelRatio }, viewport: typeof innerWidth === 'undefined' ? null : { width: innerWidth, height: innerHeight }, canvas: Array.from(context.getImageData(0, 0, 160, 48).data) };
}
const sampleScript = `(${sample.toString()})()`;
const requests = [];
let fixturePort;
const fixture = createServer((request, response) => {
  const url = new URL(request.url, 'http://fixture.local');
  requests.push({ path: url.pathname, host: request.headers.host, language: request.headers['accept-language'] ?? null });
  if (url.pathname.endsWith('.js')) {
    response.setHeader('content-type', 'application/javascript');
    if (url.pathname === '/dedicated-worker.js') response.end(`postMessage({kind:'dedicated',observation:${sampleScript}});const nested=new Worker('/nested-worker.js');nested.onmessage=e=>{postMessage({kind:'nested',observation:e.data});nested.terminate()};`);
    else if (url.pathname === '/shared-worker.js') response.end(`const first=${sampleScript};onconnect=e=>{e.ports[0].postMessage(first);e.ports[0].start()};`);
    else if (url.pathname === '/service-worker.js') response.end(`const first=${sampleScript};self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('message',e=>e.source?.postMessage({request:e.data,observation:first}));`);
    else response.end(`postMessage(${sampleScript});`);
    return;
  }
  response.setHeader('content-type', 'text/html');
  response.end(`<!doctype html><title>Owned Vesper engine qualification</title><script>window.vesperFirst=${sampleScript};</script><h1>Owned fixture</h1>${url.pathname === '/main' ? `<iframe src="/same-frame" width="400" height="250"></iframe><iframe src="http://localhost:${fixturePort}/cross-frame" width="400" height="250"></iframe>` : ''}`);
});
await new Promise(done => fixture.listen(0, '127.0.0.1', done));
fixturePort = fixture.address().port;
const origin = `http://127.0.0.1:${fixturePort}`;
const normalized = observation => {
  const { canvas, ...rest } = observation;
  return { ...rest, canvasSha256: createHash('sha256').update(Buffer.from(canvas)).digest('hex') };
};

function verify(observation, context, strictScreen) {
  assert.equal(observation.cpu, 4, `${context}: CPU`);
  assert.equal(observation.locale, 'fr-FR', `${context}: ICU locale`);
  assert.equal(observation.timezone, 'America/New_York', `${context}: timezone`);
  assert.equal(observation.language, 'fr-FR', `${context}: navigator.language`);
  if (strictScreen && observation.screen) assert.deepEqual(observation.screen, { width: 1366, height: 768, pixelRatio: 1 }, `${context}: headless native display`);
}

async function matrix(connection, record, strictScreen) {
  const page = (await connection.pages())[0];
  await page.goto(`${origin}/main`, { waitUntil: 'load', timeout: 15000 });
  record.contexts = { main: normalized(await page.evaluate(() => window.vesperFirst)) };
  for (const name of ['same-frame', 'cross-frame']) {
    const frame = page.frames().find(frame => new URL(frame.url()).pathname === `/${name}`);
    assert.ok(frame, `${name} exists`);
    await frame.waitForFunction(() => window.vesperFirst, { timeout: 10000 });
    record.contexts[name] = normalized(await frame.evaluate(() => window.vesperFirst));
  }
  const workers = await page.evaluate(() => new Promise((done, reject) => {
    const worker = new Worker('/dedicated-worker.js'), values = {};
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('Dedicated/nested worker timeout')); }, 12000);
    worker.onerror = event => { clearTimeout(timer); worker.terminate(); reject(new Error(event.message)); };
    worker.onmessage = event => { values[event.data.kind] = event.data.observation; if (values.dedicated && values.nested) { clearTimeout(timer); worker.terminate(); done(values); } };
  }));
  for (const [name, value] of Object.entries(workers)) record.contexts[name] = normalized(value);
  record.contexts.shared = normalized(await page.evaluate(() => new Promise((done, reject) => {
    const worker = new SharedWorker('/shared-worker.js'), timer = setTimeout(() => { worker.port.close(); reject(new Error('Shared worker timeout')); }, 12000);
    worker.onerror = event => { clearTimeout(timer); worker.port.close(); reject(new Error(event.message)); };
    worker.port.onmessage = event => { clearTimeout(timer); worker.port.close(); done(event.data); }; worker.port.start();
  })));
  record.contexts.service = normalized(await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.register('/service-worker.js');
    await navigator.serviceWorker.ready;
    const worker = registration.active;
    if (!worker) throw new Error('No active fixture service worker');
    return new Promise((done, reject) => {
      const request = 'vesper-first-policy';
      const timer = setTimeout(() => { navigator.serviceWorker.removeEventListener('message', receive); reject(new Error('Service worker timeout')); }, 12000);
      function receive(event) { if (event.data?.request === request) { clearTimeout(timer); navigator.serviceWorker.removeEventListener('message', receive); done(event.data.observation); } }
      navigator.serviceWorker.addEventListener('message', receive); worker.postMessage(request);
    });
  }));
  record.contexts['cross-frame-worker'] = normalized(await page.frames().find(frame => frame.url().endsWith('/cross-frame')).evaluate(() => new Promise((done, reject) => {
    const worker = new Worker('/nested-worker.js'), timer = setTimeout(() => { worker.terminate(); reject(new Error('Cross-frame worker timeout')); }, 12000);
    worker.onmessage = event => { clearTimeout(timer); worker.terminate(); done(event.data); };
    worker.onerror = event => { clearTimeout(timer); worker.terminate(); reject(new Error(event.message)); };
  })));
  for (let index = 0; index < 5; index++) {
    const url = `${origin}/popup?qualification=${randomUUID()}`, next = connection.waitForTarget(target => target.url() === url, { timeout: 15000 });
    await page.evaluate(url => window.open(url, '_blank'), url);
    const popup = await (await next).page();
    await popup.waitForFunction(() => window.vesperFirst, { timeout: 10000 });
    record.contexts[`popup-${index}`] = normalized(await popup.evaluate(() => window.vesperFirst));
    await popup.close();
  }
  const tab = await connection.newPage();
  try { await tab.goto(`${origin}/new-tab`, { timeout: 15000 }); record.contexts['new-tab'] = normalized(await tab.evaluate(() => window.vesperFirst)); }
  finally { await tab.close(); }
  record.repeatCanvas = [];
  for (let index = 0; index < 3; index++) record.repeatCanvas.push(normalized(await page.evaluate(sample)).canvasSha256);
  for (const [name, value] of Object.entries(record.contexts)) verify(value, name, strictScreen);
  record.state = 'passed';
}

async function harness(name, headless) {
  const store = join(directory, name); await mkdir(store, { recursive: true });
  await writeFile(join(store, 'selected-brave.json'), JSON.stringify(brave));
  const owner = new VesperBrowser({ directory: store, executablePath: chromium.executablePath, headless, maxConcurrency: 1 });
  const token = await browserAccessToken(store), server = await createBrowserServer(owner, token);
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${server.address().port}`;
  const client = new VesperBrowserClient({ url, tokenFile: join(store, 'admin-token') });
  await client.ready();
  return { store, owner, client, url, token, async close() { await owner.close(); await new Promise(done => server.close(done)); } };
}

async function caseRun(name, operation) {
  const record = { name, state: 'running' }; report.cases.push(record);
  try { await operation(record); record.state = 'passed'; report.checks.push(name); }
  catch (error) { record.state = 'failed'; record.error = error.message; report.failures.push({ name, error: error.message }); }
  console.log(JSON.stringify({ case: name, state: record.state, error: record.error }));
  await mkdir(output, { recursive: true }); await writeFile(join(output, 'qualification-in-progress.json'), JSON.stringify(report, null, 2));
}

async function profileCase(h, record, settings, strictScreen, archive = false) {
  const profile = await h.client.create(settings); record.profileId = profile.id;
  let connection;
  try {
    await h.client.start(profile.id);
    connection = await puppeteer.connect({ browserWSEndpoint: await h.client.connectionUrl(profile.id), defaultViewport: null });
    record.version = await connection.version();
    await matrix(connection, record, strictScreen);
    record.policy = await h.owner.fingerprintReport(profile.id);
    assert.deepEqual(record.policy.targetPolicy?.failures, [], 'Target policy errors are explicit failures');
    await connection.disconnect(); connection = undefined; await h.client.stop(profile.id);
    if (settings.engine === 'brave') {
      const preferences = JSON.parse(await readFile(join(h.store, 'profiles', profile.id, 'browser', 'Default', 'Preferences'), 'utf8'));
      record.nativeFingerprintSetting = preferences.profile.default_content_setting_values.fingerprintingV2;
      assert.equal(record.nativeFingerprintSetting, settings.fingerprint.protection === 'off' ? 1 : 3);
    }
    if (archive) {
      const file = join(directory, `archive-${randomUUID()}.tgz`); await h.client.export(profile.id, file);
      const imported = await h.client.importProfile(file); record.importedId = imported.id;
      const manifest = await h.client.readProfile(imported.id);
      for (const key of ['locale', 'timezone', 'environment', 'fingerprint']) assert.deepEqual(manifest.settings[key], settings[key], `Imported ${key}`);
      await h.client.start(imported.id);
      connection = await puppeteer.connect({ browserWSEndpoint: await h.client.connectionUrl(imported.id), defaultViewport: null });
      const page = (await connection.pages())[0]; await page.goto(`${origin}/imported`);
      record.importedFirst = normalized(await page.evaluate(() => window.vesperFirst)); verify(record.importedFirst, 'imported first script', strictScreen);
      await connection.disconnect(); connection = undefined; await h.client.stop(imported.id);
    }
  } catch (error) {
    record.policy = await h.owner.fingerprintReport(profile.id).catch(() => null);
    throw error;
  } finally { await connection?.disconnect().catch(() => {}); await h.client.stop(profile.id).catch(() => {}); }
}

let current, runtime;
try {
  current = await harness('chromium-headless', true);
  await caseRun('Authenticated API and automation lease', async record => {
    assert.equal((await fetch(`${current.url}/api/v1/profiles`)).status, 401);
    const profile = await current.client.create({ name: 'Owned lease fixture', ...policy });
    await current.client.claimProfile(profile.id, randomUUID());
    try {
      const response = await fetch(`${current.url}/api/v1/profiles/${profile.id}`, { method: 'PATCH', headers: { authorization: `Bearer ${current.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Should be blocked' }) });
      assert.equal(response.status, 409); record.unownedWriteStatus = response.status;
    } finally { await current.client.releaseProfile(profile.id); }
  });
  await caseRun('Engine activation canary, admission lock and rejected candidate rollback', async record => {
    const buildId = chromium.buildId || '1716330';
    const staged = { family: 'chromium', buildId, executablePath: chromium.executablePath };
    await writeFile(join(current.store, 'engine-updates.json'), JSON.stringify({ staged: [staged] }));
    const activation = current.client.activateEngine(buildId);
    // Handle an early rejection immediately while waiting for the maintenance flag.
    activation.catch(() => {});
    const deadline = Date.now() + 10000;
    while (!current.owner.engineBusy && Date.now() < deadline) await new Promise(done => setTimeout(done, 10));
    assert.equal(current.owner.engineBusy, true, 'Activation holds an admission lock');
    const existing = (await current.client.listProfiles())[0];
    await assert.rejects(current.owner.create({ name: 'Denied during activation' }), /activation is in progress/);
    const queuedLease = current.client.claimProfile(existing.id, randomUUID());
    record.activation = await activation;
    assert.equal(record.activation.qualification.state, 'passed');
    assert.ok(record.activation.profilesBackedUp >= 1);
    assert.equal(current.owner.engineBusy, false);
    // HTTP mutations are already serialized by BrowserContract. The lease
    // request is admitted only after activation releases the maintenance lock.
    await queuedLease;
    record.queuedLeaseStatus = 200;
    await current.client.releaseProfile(existing.id);
    const selectedFile = join(current.store, 'selected-browser.json');
    const selection = await readFile(selectedFile, 'utf8');
    const state = JSON.parse(await readFile(join(current.store, 'engine-updates.json'), 'utf8'));
    state.staged.push({ family: 'chromium', buildId: '9999999', executablePath: process.execPath });
    await writeFile(join(current.store, 'engine-updates.json'), JSON.stringify(state));
    await assert.rejects(current.client.activateEngine('9999999'), /qualification failed/);
    assert.equal(await readFile(selectedFile, 'utf8'), selection, 'A rejected candidate cannot switch the active engine');
    const rejected = (await current.owner.engineVersions()).staged.find(entry => entry.buildId === '9999999');
    assert.equal(rejected.qualification.state, 'failed');
    record.rejectedCandidate = { state: rejected.qualification.state, errors: rejected.qualification.errors };
    assert.equal(current.owner.engineBusy, false);
  });
  await caseRun('Chromium headless first-script context matrix and archive import', record => profileCase(current, record, { ...policy, engine: 'chromium', fingerprint: { protection: 'off' } }, true, true));
  await caseRun('Workbench Runtime with Browser client, saved archive and profile policy', async record => {
    const automations = join(directory, 'automations'); await mkdir(automations);
    await writeFile(join(automations, 'native-policy.mjs'), `import assert from 'node:assert/strict';export default {id:'native-policy',title:'Owned native policy qualification',inputSchema:{type:'object',additionalProperties:false},profile:()=>(${JSON.stringify({ ...policy, engine: 'chromium', fingerprint: { protection: 'off' } })}),async run({page,log,done}){await page.goto(${JSON.stringify(origin + '/workbench')});const v=await page.evaluate(()=>{const n=navigator;return{cpu:n.hardwareConcurrency,language:n.language,locale:Intl.DateTimeFormat().resolvedOptions().locale,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,screen:{width:screen.width,height:screen.height,pixelRatio:devicePixelRatio}}});assert.equal(v.cpu,4);assert.equal(v.locale,'fr-FR');assert.equal(v.language,'fr-FR');assert.equal(v.timezone,'America/New_York');assert.deepEqual(v.screen,{width:1366,height:768,pixelRatio:1});log('POLICY_OBSERVATION '+JSON.stringify(v));await done();}};`);
    runtime = new Runtime({ engine: current.client, engineUrl: current.url, dataDir: join(directory, 'runs'), engineExportDir: join(directory, 'exports'), localExportDir: join(directory, 'exports'), automationsDir: automations, maxConcurrency: 1, runTimeoutMs: 60000 });
    await runtime.init(); const run = await runtime.submit({ automationId: 'native-policy', inputs: {}, preset: 'fast' });
    const deadline = Date.now() + 65000; let saved;
    while (Date.now() < deadline) { saved = runtime.get(run.id); if (['saved', 'failed', 'export_failed', 'interrupted', 'cancelled'].includes(saved.state)) break; await new Promise(done => setTimeout(done, 50)); }
    record.run = { id: run.id, state: saved.state, error: saved.error, logs: saved.logs };
    assert.equal(saved.state, 'saved');
    assert.equal(createHash('sha256').update(await readFile(saved.artifact.path)).digest('hex'), saved.artifact.sha256);
    record.archive = { bytes: saved.artifact.bytes, sha256: saved.artifact.sha256 };
    const manifest = await current.client.readProfile(saved.profileId); assert.deepEqual(manifest.settings.environment, policy.environment);
    await runtime.close(); runtime = undefined;
  });
  await current.close(); current = undefined;
  current = await harness('chromium-headed', false);
  await caseRun('Chromium headed context policy with explicit native screen limitation', async record => {
    await profileCase(current, record, { ...policy, engine: 'chromium', fingerprint: { protection: 'off' } }, false);
    record.screenLimitation = { requested: policy.environment.screen, main: record.contexts.main.screen, crossFrame: record.contexts['cross-frame'].screen, coherent: record.contexts.main.screen.width === record.contexts['cross-frame'].screen.width && record.contexts.main.screen.height === record.contexts['cross-frame'].screen.height };
  });
  await current.close(); current = undefined;
  current = await harness('brave-headless', true);
  for (const protection of ['off', 'standard']) for (let index = 0; index < 2; index++) await caseRun(`Brave ${protection} native policy profile ${index + 1}`, record => profileCase(current, record, { ...policy, engine: 'brave', fingerprint: { protection } }, false));
  const privacy = report.cases.filter(record => record.name.startsWith('Brave ') && record.state === 'passed');
  report.nativePrivacyObservations = privacy.map(record => ({ name: record.name, preference: record.nativeFingerprintSetting, repeatedMainEqual: new Set(record.repeatCanvas).size === 1, pageCanvas: record.contexts.main.canvasSha256, workerCanvas: record.contexts.dedicated.canvasSha256, screen: record.contexts.main.screen, crossFrameScreen: record.contexts['cross-frame'].screen }));
  await caseRun('Native Brave canvas protection affects pixels and preserves same-origin worker consistency', async () => {
    assert.equal(privacy.length, 4);
    const off = privacy.filter(record => record.name.startsWith('Brave off'));
    const standard = privacy.filter(record => record.name.startsWith('Brave standard'));
    assert.equal(off[0].contexts.main.canvasSha256, off[1].contexts.main.canvasSha256);
    assert.notEqual(standard[0].contexts.main.canvasSha256, standard[1].contexts.main.canvasSha256);
    for (const record of privacy) {
      assert.equal(new Set(record.repeatCanvas).size, 1);
      assert.equal(record.contexts.main.canvasSha256, record.contexts.dedicated.canvasSha256);
    }
    for (const record of standard) assert.notEqual(record.contexts.main.canvasSha256, off[0].contexts.main.canvasSha256);
  });
  report.nativePrivacyInterpretation = 'Canvas equality/differences are recorded rather than equated with spoofing quality. Standard protection belongs to upstream Brave; off/standard native preferences and actual context policy are asserted.';
} catch (error) { report.failures.push({ name: 'Harness', error: error.message }); }
finally {
  await runtime?.close().catch(error => report.failures.push({ name: 'Runtime cleanup', error: error.message }));
  await current?.close().catch(error => report.failures.push({ name: 'Browser cleanup', error: error.message }));
  await new Promise(done => fixture.close(done));
  report.requests = requests; report.state = report.failures.length ? 'failed' : 'passed';
  await mkdir(output, { recursive: true }); await writeFile(join(output, 'qualification.json'), JSON.stringify(report, null, 2));
  const target = resolve(directory), temporaryRoot = resolve(tmpdir());
  assert.ok(target.startsWith(temporaryRoot + '\\') || target.startsWith(temporaryRoot + '/'));
  await rm(target, { recursive: true, force: true });
  console.log(JSON.stringify({ state: report.state, checks: report.checks, failures: report.failures, output: join(output, 'qualification.json') }, null, 2));
  if (report.failures.length) process.exitCode = 1;
}
