import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';
import { VesperBrowserClient } from '../packages/vesper-browser/dist/index.js';
import { VesperWorkbenchClient } from '../dist/client.js';
import { extensionZip } from './fixtures/extension-package.mjs';

const index = process.argv.indexOf('--data-root');
if (index < 0 || !process.argv[index + 1]) throw new Error('Usage: node scripts/qualify-installed-pair.mjs --data-root <running desktop data directory>');
const directory = resolve(process.argv[index + 1]);
const packaged = process.argv.includes('--packaged');
const output = resolve(packaged ? 'test-results/desktop-followup' : 'test-results/native-engine'); await mkdir(output, { recursive: true });
const report = { at: new Date().toISOString(), source: packaged ? 'Packaged desktop Browser and signed Workbench add-on; isolated temporary store' : 'Actual installed desktop Browser and enabled Workbench add-on', state: 'running', checks: [], errors: [] };
async function service(kind) {
  const record = JSON.parse(await readFile(join(directory, kind, 'service.json'), 'utf8'));
  const token = (await readFile(join(directory, kind, 'admin-token'), 'utf8')).trim();
  assert.ok(Number.isInteger(record.port) && record.port > 0 && record.port < 65536);
  const url = `http://127.0.0.1:${record.port}`;
  const api = async (path, method = 'GET', data) => {
    const response = await fetch(url + path, { method, signal: AbortSignal.timeout(30000), headers: { authorization: `Bearer ${token}`, ...(data ? { 'content-type': 'application/json' } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) });
    if (!response.ok) throw new Error(`${kind}: ${response.status} ${await response.text()}`);
    return response.headers.get('content-type')?.includes('json') ? response.json() : Buffer.from(await response.arrayBuffer());
  };
  return { api, url };
}
const browser = await service('browser'), workbench = await service('workbench');
const before = await browser.api('/api/v1/profiles');
assert.ok(before.every(profile => profile.state !== 'running' && !profile.lease), 'Qualification requires idle profiles');
const baseline = before.map(profile => ({ id: profile.id, name: profile.name, settings: profile.settings }));
const fixture = createServer((_request, response) => { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><script>window.first={cpu:navigator.hardwareConcurrency,language:navigator.language,locale:Intl.DateTimeFormat().resolvedOptions().locale,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone}</script><h1>Vesper installed-pair fixture by true-utopian</h1>'); });
await new Promise(done => fixture.listen(0, '127.0.0.1', done));
const fixtureUrl = `http://127.0.0.1:${fixture.address().port}`;
let runId, connection, finished = false, temporary, scheduleId, importedId, client;
const extended = process.argv.includes('--extended');
const catalogRemoval = process.argv.includes('--catalog-removal');
if(catalogRemoval && !extended)throw new Error('Catalog removal qualification requires --extended');
const catalogBaseline = catalogRemoval ? await browser.api('/api/v1/extensions') : undefined;
let ownedExtension;
async function waitRun(id, states) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const state = await workbench.api(`/api/v1/runs/${id}`);
    if (states.includes(state.state)) return state;
    if (['failed','export_failed','interrupted','cancelled'].includes(state.state)) throw new Error(`Installed run ${state.state}: ${state.error}`);
    await new Promise(done => setTimeout(done, 200));
  }
  throw new Error('Installed run timed out');
}
try {
  report.versions = { browser: (await browser.api('/api/v1/capabilities')).version, workbench: (await workbench.api('/api/v1/capabilities')).version };
  client = new VesperBrowserClient({ url: browser.url, tokenFile: join(directory, 'browser', 'admin-token') });
  const extraInputs = {};
  if (extended) {
    temporary = await mkdtemp(join(tmpdir(), 'vesper-installed-proof-'));
    const file = join(temporary, 'original-fixture.zip');
    const nonce=randomBytes(6),version=catalogRemoval?'3.'+[0,2,4].map(offset=>nonce.readUInt16LE(offset)).join('.'):'1.0.0';
    await writeFile(file, extensionZip(version));
    const extension = await client.importExtension(file); ownedExtension=extension; extraInputs.extensions = [extension.id];
    const calendar = new VesperWorkbenchClient({ url: workbench.url, token: (await readFile(join(directory, 'workbench', 'admin-token'), 'utf8')).trim() });
    const preview = await calendar.calendarPreview('0 9 * * *', 'Europe/London', Date.parse('2026-03-28T00:00:00Z'));
    assert.equal(preview.occurrences.length, 5); assert.equal(preview.occurrences[1], Date.parse('2026-03-29T08:00:00Z'));
    const schedule = await calendar.createSchedule({ name: 'Owned installed calendar qualification', automationId: 'inspect', inputs: { url: fixtureUrl, engine: 'chromium' }, cron: '0 9 * * 1-5', timezone: 'Europe/London', nextAt: Date.parse('2030-01-01T00:00:00Z') });
    scheduleId = schedule.id; assert.equal(schedule.timezone, 'Europe/London');
    await calendar.scheduleControl(scheduleId, 'pause');
    assert.equal((await calendar.schedules()).find(item => item.id === scheduleId).enabled, false);
    await calendar.scheduleControl(scheduleId, 'remove'); scheduleId = undefined;
    report.calendar = { preview: preview.occurrences, timezone: 'Europe/London', createdPausedAndRemoved: true };
    report.checks.push('Installed calendar API and TypeScript client preview the London DST transition and create/pause/remove a future schedule');
  }
  const run = await workbench.api('/api/v1/runs', 'POST', { automationId: 'inspect', inputs: { url: fixtureUrl, engine: 'chromium', locale: 'fr-FR', timezone: 'America/New_York', cpu: 4, ...extraInputs }, preset: 'fast' });
  runId = run.id; const running = await waitRun(runId, ['running']);
  await client.claimProfile(running.profileId, runId);
  connection = await puppeteer.connect({ browserWSEndpoint: await client.connectionUrl(running.profileId), defaultViewport: null });
  const target = await connection.waitForTarget(target => target.type() === 'page' && target.url().startsWith(fixtureUrl), { timeout: 20000 });
  const page = await target.page(); assert.ok(page);
  report.firstScript = await page.evaluate(() => window.first);
  assert.deepEqual(report.firstScript, { cpu: 4, language: 'fr-FR', locale: 'fr-FR', timezone: 'America/New_York' });
  if (extended) {
    await page.waitForFunction(() => document.documentElement.dataset.vesperExtension, { timeout: 20000 });
    report.extension = await page.evaluate(() => JSON.parse(document.documentElement.dataset.vesperExtension));
    assert.equal(report.extension.content.cpu, 4); assert.equal(report.extension.content.language, 'fr-FR');
    assert.equal(report.extension.first.language, 'fr-FR'); assert.equal(report.extension.visits, 1);
    report.checks.push('Installed Workbench forwards the original extension selection; content script, startup worker and extension storage execute');
  }
  const policy = await browser.api(`/api/v1/profiles/${running.profileId}/fingerprint`);
  assert.equal(policy.policyOwnerConnected, true); assert.deepEqual(policy.targetPolicy.failures, []);
  await connection.disconnect(); connection = undefined;
  await workbench.api(`/api/v1/runs/${runId}/finish`, 'POST', {});
  const saved = await waitRun(runId, ['saved']); finished = true;
  const artifact = await workbench.api(`/api/v1/runs/${runId}/artifact`);
  assert.equal(createHash('sha256').update(artifact).digest('hex'), saved.artifact.sha256);
  report.run = { id: runId, profileId: running.profileId, state: saved.state, archiveBytes: artifact.length, sha256: saved.artifact.sha256 };
  if (extended) {
    const file = join(temporary, 'owned-saved-profile.tgz'); await writeFile(file, artifact);
    const imported = await client.importProfile(file); importedId = imported.id;
    await client.claimProfile(importedId, runId);
    await client.start(importedId);
    connection = await puppeteer.connect({ browserWSEndpoint: await client.connectionUrl(importedId), defaultViewport: null });
    const page = await connection.newPage(); await page.goto(fixtureUrl);
    await page.waitForFunction(() => document.documentElement.dataset.vesperExtension, { timeout: 20000 });
    report.importedExtension = await page.evaluate(() => JSON.parse(document.documentElement.dataset.vesperExtension));
    assert.equal(report.importedExtension.visits, 2); assert.equal(report.importedExtension.content.cpu, 4);
    await connection.disconnect(); connection = undefined; await client.stop(importedId); await client.releaseProfile(importedId);
    report.checks.push('Installed Browser imports the saved extension archive into a new profile and retains its browser identity and storage');
    if(catalogRemoval){
      await assert.rejects(client.removeExtension(ownedExtension.id),error=>error.status===409);
      await client.update(saved.profileId,{extensions:[]});await client.update(importedId,{extensions:[]});
      assert.deepEqual(await client.removeExtension(ownedExtension.id),{id:ownedExtension.id,removed:true});
      assert.ok(!(await client.extensions()).some(extension=>extension.id===ownedExtension.id));
      await client.update(importedId,{extensions:[ownedExtension.id]});await client.start(importedId);
      connection=await puppeteer.connect({browserWSEndpoint:await client.connectionUrl(importedId),defaultViewport:null});
      const restoredPage=await connection.newPage();await restoredPage.goto(fixtureUrl);
      await restoredPage.waitForFunction(()=>document.documentElement.dataset.vesperExtension,{timeout:20000});
      const retained=await restoredPage.evaluate(()=>JSON.parse(document.documentElement.dataset.vesperExtension));assert.equal(retained.visits,3);
      await connection.disconnect();connection=undefined;await client.stop(importedId);await client.update(importedId,{extensions:[]});
      const restored=await client.importExtension(join(temporary,'original-fixture.zip'));assert.equal(restored.id,ownedExtension.id);await client.removeExtension(restored.id);
      assert.deepEqual(await client.extensions(),catalogBaseline);
      report.catalogRemoval={assignedRefusal:true,removed:true,retainedStorageVisits:retained.visits,reimportIdentity:true,existingCatalogUntouched:true};
      report.checks.push('Installed catalog removal refuses assigned packages; retained profile copies and storage survive removal, and re-import preserves identity');
    }
    importedId = undefined;
  }
  const after = await browser.api('/api/v1/profiles');
  assert.deepEqual(after.filter(profile => before.some(old => old.id === profile.id)).map(profile => ({ id: profile.id, name: profile.name, settings: profile.settings })), baseline);
  assert.ok(after.every(profile => profile.state !== 'running' && !profile.lease));
  report.checks.push('Installed Workbench launches through the installed Browser API', 'First-script CPU, locale, language and timezone on an owned loopback fixture', 'Browser policy controller retains ownership without failures', 'Finish closes the browser and saves a SHA-256 verified profile archive', 'Existing profiles remain unchanged and all leases are released');
  report.state = 'passed';
} catch (error) { report.state = 'failed'; report.errors.push(error.stack ?? String(error)); process.exitCode = 1; }
finally {
  await connection?.disconnect().catch(() => {});
  if (runId && !finished) await workbench.api(`/api/v1/runs/${runId}/cancel`, 'POST', {}).catch(error => report.errors.push(`Cleanup: ${error.message}`));
  if (importedId) { await client.stop(importedId).catch(error => report.errors.push(`Imported fixture cleanup: ${error.message}`)); await client.releaseProfile(importedId).catch(error => report.errors.push(`Imported lease cleanup: ${error.message}`)); }
  if (scheduleId) await workbench.api(`/api/v1/schedules/${scheduleId}/remove`, 'POST', {}).catch(error => report.errors.push(`Schedule cleanup: ${error.message}`));
  if (temporary) { const path = await realpath(temporary); assert.ok(path.startsWith(join(await realpath(tmpdir()), 'vesper-installed-proof-'))); await rm(path, { recursive: true, force: true }); }
  await new Promise(done => fixture.close(done));
  report.completedAt = new Date().toISOString();
  await writeFile(join(output, packaged ? 'packaged-api-pair.json' : 'installed-pair-qualification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ state: report.state, versions: report.versions, run: report.run, errors: report.errors }));
}
