import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { KameleoLocalApiClient } from '@kameleo/local-api-client';
import puppeteer from 'puppeteer-core';

// Opt-in UI check using a disposable Kameleo profile. The screenshot is private output.
const engine = process.env.IMPORT_KAMELEO_URL ?? process.env.KAMELEO_URL ?? 'http://127.0.0.1:5050';
const base = process.env.UI_WORKBENCH_URL ?? process.env.WORKBENCH_URL ?? 'http://127.0.0.1:3180';
const token = process.env.WORKBENCH_TOKEN || (await readFile(path.join(process.env.WORKBENCH_DATA_DIR ?? '.workbench', 'admin-token'), 'utf8')).trim();
const output = path.resolve(process.env.UI_SCREENSHOT_DIR ?? 'test-results');
await mkdir(output, { recursive: true, mode: 0o700 });
const client = new KameleoLocalApiClient({ basePath: engine });
const profile = await client.profile.createProfile({ name: 'workbench-ui-smoke', storage: 'local' });
let browser;
try {
  await client.profile.startProfile(profile.id);
  const endpoint = new URL(engine); endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:'; endpoint.pathname = `/puppeteer/${profile.id}`;
  browser = await puppeteer.connect({ browserWSEndpoint: endpoint.href, defaultViewport: { width: 1440, height: 960 } });
  const page = (await browser.pages())[0] ?? await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base, { waitUntil: 'networkidle0' });
  await page.type('#access-token', token);
  await page.click('#login-button');
  await page.waitForFunction(() => !document.getElementById('workspace').hidden);
  await page.waitForFunction(() => document.getElementById('connection-status').textContent.includes('connected'));
  await page.waitForFunction(() => document.getElementById('system-button').textContent.includes('Engine ready'));
  await page.screenshot({ path: path.join(output, 'workbench-desktop.jpg'), type: 'jpeg', quality: 88, fullPage: true });
  await page.click('#new-run-button');
  await page.waitForSelector('#new-run-dialog[open]');
  const scripts = await page.$$eval('#automation-select option', options => options.map(option => option.value));
  assert.ok(['demo', 'inspect', 'challenge-demo'].every(id => scripts.includes(id)));
  await page.select('#automation-select', 'demo');
  assert.equal(await page.$$eval('#input-fields [data-field]', fields => fields.length), 2);
  await page.setViewport({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(output, 'workbench-mobile.jpg'), type: 'jpeg', quality: 88, fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Mobile page overflows horizontally');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ui: 'passed', scripts, screenshots: output, mobileWidth: 390 }));
} finally {
  await browser?.disconnect();
  await client.profile.stopProfile(profile.id);
  // Only the fresh profile created above is removed; it contains the test owner session.
  await client.profile.deleteProfile(profile.id);
}
