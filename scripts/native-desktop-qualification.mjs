import assert from 'node:assert/strict';
import { _electron } from 'playwright';
import puppeteer from 'puppeteer-core';
import { VesperBrowserClient } from '../packages/vesper-browser/dist/index.js';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
const output = resolve('test-results/native-engine'), directory = await mkdtemp(join(tmpdir(), 'vesper-native-desktop-'));
const brave = JSON.parse(await readFile('test-results/expansion/native-data/browser/selected-brave.json', 'utf8'));
await mkdir(join(directory, 'browser'));
await writeFile(join(directory, 'browser/selected-brave.json'), JSON.stringify(brave));
await writeFile(join(directory, 'browser/engine-updates.json'), JSON.stringify({ staged: [{ ...brave, family: 'brave' }] }));
const fixture = createServer((_request, response) => { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><script>window.first={cpu:navigator.hardwareConcurrency,language:navigator.language,locale:Intl.DateTimeFormat().resolvedOptions().locale,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone}</script><h1>Owned Vesper desktop fixture</h1>'); });
await new Promise(done => fixture.listen(0, '127.0.0.1', done));
const fixtureUrl = `http://127.0.0.1:${fixture.address().port}`;
let app, connection, browserApi, wbApi, runId;
const products={browser:JSON.parse(await readFile('packages/vesper-browser/package.json','utf8')).version,workbench:JSON.parse(await readFile('package.json','utf8')).version};
const report = { versions: products, source: 'Packaged Windows Browser and signed Workbench add-on; isolated temporary store', checks: [], errors: [] };
async function serviceApi(kind) {
  const record = JSON.parse(await readFile(join(directory, kind, 'service.json'), 'utf8'));
  const token = (await readFile(join(directory, kind, 'admin-token'), 'utf8')).trim();
  const api = async (path, method = 'GET', body) => {
    const response = await fetch(`http://127.0.0.1:${record.port}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error(`QA ${kind}: ${response.status} ${await response.text()}`);
    return response.headers.get('content-type')?.includes('json') ? response.json() : Buffer.from(await response.arrayBuffer());
  };
  api.url = `http://127.0.0.1:${record.port}`; return api;
}
try {
  app = await _electron.launch({ executablePath: resolve('release/browser/win32/win-unpacked/vesper-browser.exe'), env: Object.fromEntries(Object.entries({ ...process.env, VESPER_DESKTOP_DATA_DIR: directory, VESPER_BROWSER_HEADLESS: 'true' }).filter(([key])=>key!=='ELECTRON_RUN_AS_NODE')), timeout: 120000 });
  const page = await app.firstWindow(); page.on('pageerror', error => report.errors.push(error.message));
  await page.waitForSelector('#workspace:not([hidden])', { timeout: 120000 });
  browserApi = await serviceApi('browser');
  assert.equal((await browserApi('/api/v1/capabilities')).version, products.browser);
  await page.click('#create'); await page.fill('[name=name]', 'Native protection UI fixture');
  await page.selectOption('[name=engine]', 'brave');
  await page.locator('#fingerprint-setting').waitFor({ state: 'visible' });
  await page.selectOption('[name=fingerprintProtection]', 'standard');
  await page.locator('#profile-form button[type=submit]').click();
  await page.locator('#profile-dialog').waitFor({ state: 'hidden' });
  assert.equal((await browserApi('/api/v1/profiles')).find(profile => profile.name === 'Native protection UI fixture').settings.fingerprint.protection, 'standard');
  report.checks.push('Packaged native protection editor saves actual profile policy');
  await page.click('#updates-view');
  await page.getByRole('button', { name: 'Test engine', exact: true }).click();
  await page.getByText('Engine test: passed', { exact: false }).waitFor({ timeout: 120000 });
  report.checks.push('Engine UI runs and displays a real Brave worker canary');
  await page.screenshot({ path: join(output, 'native-engine-desktop.png') });
  const manifestPath = resolve(`release/addons/Vesper-workbench-${products.workbench}.vplugin.tgz.vesper-plugin.json`);
  // Test-only native picker fixture in this isolated application instance.
  await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); dialog.showMessageBox = async () => ({ response: 0 }); }, manifestPath);
  const installed = await page.evaluate(() => window.vesperDesktop.installWorkbench());
  assert.equal(installed.version, products.workbench);
  await page.evaluate(() => window.vesperDesktop.setWorkbenchEnabled(true));
  await page.click('#addons-view');
  await page.locator('#workbench-view').waitFor({ state: 'visible' });
  await page.click('#workbench-view');
  wbApi = await serviceApi('workbench');
  let nativeViews;
  for (let attempt = 0; attempt < 100; attempt++) {
    nativeViews = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.map(view => ({ url: view.webContents?.getURL(), bounds: view.getBounds() })));
    if (nativeViews.some(view => view.url?.startsWith(wbApi.url) && view.bounds.width > 0 && view.bounds.height > 0)) break;
    await new Promise(done => setTimeout(done, 100));
  }
  assert.ok(nativeViews.some(view => view.url?.startsWith(wbApi.url) && view.bounds.width > 0 && view.bounds.height > 0), 'Native Workbench child view must exist and have visible bounds');
  report.nativeViews = nativeViews;
  assert.equal((await wbApi('/api/v1/capabilities')).version, products.workbench);
  report.checks.push(`Signed ${products.workbench} add-on installs, enables and embeds in native ${products.browser} Browser`);
  const run = await wbApi('/api/v1/runs', 'POST', { automationId: 'inspect', inputs: { url: fixtureUrl, engine: 'brave', protection: 'standard', locale: 'fr-FR', timezone: 'America/New_York', cpu: 4 }, preset: 'fast' });
  runId = run.id;
  let state;
  for (let attempt = 0; attempt < 400; attempt++) { state = await wbApi(`/api/v1/runs/${run.id}`); if (['running','failed','saved','export_failed'].includes(state.state)) break; await new Promise(done => setTimeout(done, 100)); }
  assert.equal(state.state, 'running', state.error);
  const listed = await browserApi('/api/v1/profiles');
  const profile = listed.find(profile => profile.id === state.profileId);
  assert.equal(profile.settings.fingerprint.protection, 'standard'); assert.equal(profile.settings.environment.hardwareConcurrency, 4);
  // Native policy report is read-only and does not require the run's CDP lease.
  const policy = await browserApi(`/api/v1/profiles/${profile.id}/fingerprint`);
  assert.equal(policy.policyOwnerConnected, true); assert.deepEqual(policy.targetPolicy.failures, []);
  const browserClient = new VesperBrowserClient({ url: browserApi.url, tokenFile: join(directory, 'browser/admin-token') });
  await browserClient.claimProfile(profile.id, run.id);
  connection = await puppeteer.connect({ browserWSEndpoint: await browserClient.connectionUrl(profile.id), defaultViewport: null });
  const actualTarget = await connection.waitForTarget(target => target.type() === 'page' && target.url().startsWith(fixtureUrl), { timeout: 20000 });
  const actualPage = await actualTarget.page();
  assert.ok(actualPage, 'Packaged automation navigated to the owned fixture');
  report.firstScript = await actualPage.evaluate(() => window.first);
  assert.deepEqual(report.firstScript, { cpu: 4, language: 'fr-FR', locale: 'fr-FR', timezone: 'America/New_York' });
  await connection.disconnect(); connection = undefined;
  await wbApi(`/api/v1/runs/${run.id}/finish`, 'POST', {});
  for (let attempt = 0; attempt < 400; attempt++) { state = await wbApi(`/api/v1/runs/${run.id}`); if (['saved','failed','export_failed'].includes(state.state)) break; await new Promise(done => setTimeout(done, 100)); }
  assert.equal(state.state, 'saved', state.error);
  const artifact = await wbApi(`/api/v1/runs/${run.id}/artifact`);
  assert.equal(createHash('sha256').update(artifact).digest('hex'), state.artifact.sha256);
  report.run = { state: state.state, archiveBytes: artifact.length, sha256: state.artifact.sha256 };
  report.checks.push('Packaged Inspect add-on forwards native policy and saves a verified Browser-owned archive');
} catch (error) { report.errors.push(error.stack); }
finally {
  if (wbApi && runId && report.errors.length) {
    await wbApi(`/api/v1/runs/${runId}/cancel`, 'POST', {}).catch(() => {});
    for (let attempt = 0; attempt < 200; attempt++) {
      const state = await wbApi(`/api/v1/runs/${runId}`).catch(() => null);
      if (state && ['saved','cancelled','failed','interrupted'].includes(state.state) && !state.cleanupRequired) break;
      await new Promise(done => setTimeout(done, 100));
    }
  }
  await connection?.disconnect().catch(() => {});
  if (browserApi) await browserApi('/api/v1/service/shutdown', 'POST', {}).catch(() => {});
  if (app) { await app.evaluate(({ app }) => app.quit()).catch(() => {}); await app.close().catch(() => {}); }
  await new Promise(done => fixture.close(done));
  report.state = report.errors.length ? 'failed' : 'passed';
  await writeFile(join(output, 'desktop-qualification.json'), JSON.stringify(report, null, 2));
  const child = relative(resolve(tmpdir()), resolve(directory));
  assert.ok(child.startsWith('vesper-native-desktop-') && !child.startsWith('..') && !isAbsolute(child));
  await rm(directory, { recursive: true, force: true });
  console.log(JSON.stringify(report, null, 2)); if (report.errors.length) process.exitCode = 1;
}
