import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { KameleoLocalApiClient } from '@kameleo/local-api-client';
import puppeteer from 'puppeteer-core';

// Opt-in integration test. Retains test profiles for inspection.
const base = process.env.WORKBENCH_URL ?? 'http://127.0.0.1:3180';
const engineUrl = process.env.KAMELEO_URL ?? 'http://127.0.0.1:5050';
const fixture = process.env.DEMO_URL ?? `${base}/demo`;
const token = process.env.WORKBENCH_TOKEN || (await readFile(path.join(process.env.WORKBENCH_DATA_DIR ?? '.workbench', 'admin-token'), 'utf8')).trim();
async function api(url, options = {}) {
  const response = await fetch(`${base}${url}`, { ...options, headers: { Authorization: `Bearer ${token}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response;
}
const started = Date.now();
let run = process.env.SMOKE_RUN_ID
  ? await (await api(`/api/runs/${process.env.SMOKE_RUN_ID}`)).json()
  : await (await api('/api/runs', { method: 'POST', body: JSON.stringify({ automationId: 'demo', inputs: { url: fixture, message: 'Workbench integration test' }, preset: process.env.SMOKE_PRESET ?? 'fast' }) })).json();
if (run.state === 'export_failed') run = await (await api(`/api/runs/${run.id}/retry-export`, { method: 'POST' })).json();
console.log(`Submitted ${run.id}`);
const deadline = Date.now() + 10 * 60_000;
while (!['saved', 'failed', 'cancelled', 'export_failed', 'interrupted'].includes(run.state)) {
  if (Date.now() > deadline) throw new Error('Run did not finish before the smoke-test deadline.');
  await delay(1000);
  run = await (await api(`/api/runs/${run.id}`)).json();
}
assert.equal(run.state, 'saved', JSON.stringify({ state: run.state, error: run.error, logs: run.logs }));
const bytes = Buffer.from(await (await api(`/api/runs/${run.id}/artifact`)).arrayBuffer());
assert.equal(bytes.length, run.artifact.bytes);
assert.equal(createHash('sha256').update(bytes).digest('hex'), run.artifact.sha256);
console.log(JSON.stringify({ runId: run.id, profileId: run.profileId, bytes: bytes.length, sha256: run.artifact.sha256, elapsedMs: Date.now() - started, timings: run.timings }));

const importEngineUrl = process.env.IMPORT_KAMELEO_URL;
if (!importEngineUrl) {
  console.log('Archive verified. Set IMPORT_KAMELEO_URL to an Engine with a separate workspace to test restoration.');
  process.exit(0);
}
// Kameleo archives preserve profile IDs, so importing beside the original is rejected.
const client = new KameleoLocalApiClient({ basePath: importEngineUrl });
const engineDirectory = process.env.KAMELEO_EXPORT_DIR ?? path.resolve(process.env.EXPORT_DIR ?? 'profiles');
const join = /^[A-Za-z]:[\\/]/.test(engineDirectory) ? path.win32.join : path.posix.join;
const imported = await client.profile.importProfile({ path: join(engineDirectory, run.artifact.name) });
let browser;
try {
  await client.profile.startProfile(imported.id);
  const endpoint = new URL(importEngineUrl); endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:'; endpoint.pathname = `/puppeteer/${imported.id}`;
  browser = await puppeteer.connect({ browserWSEndpoint: endpoint.href, defaultViewport: null });
  const page = (await browser.pages())[0] ?? await browser.newPage();
  await page.goto(fixture, { waitUntil: 'domcontentloaded' });
  assert.equal(await page.evaluate(() => localStorage.getItem('workbench-demo')), 'completed');
  const cookies = await browser.cookies();
  assert.ok(cookies.some(cookie => cookie.name === 'workbench_demo' && cookie.value === 'completed'));
  console.log(JSON.stringify({ importedProfileId: imported.id, restoredLocalStorage: true, restoredCookie: true }));
} finally {
  await browser?.disconnect();
  await client.profile.stopProfile(imported.id);
}
