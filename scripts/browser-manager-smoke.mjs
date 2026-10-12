import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';
import { VesperBrowser, VesperBrowserClient, browserAccessToken, createBrowserServer } from '@true-utopian/vesper-browser';

const directory = await mkdtemp(join(tmpdir(), 'vesper-manager-smoke-'));
const output = resolve('test-results/vesper-browser-manager');
const executablePath = process.env.LOCAL_BROWSER_EXECUTABLE || JSON.parse(await readFile(resolve('.workbench/local-engine/browser.json'), 'utf8')).executablePath;
const engine = new VesperBrowser({ directory: join(directory, 'engine'), executablePath, headless: true });
const token = await browserAccessToken(join(directory, 'engine'));
const server = await createBrowserServer(engine, token);
await new Promise(done => server.listen(0, '127.0.0.1', done));
const address = `http://127.0.0.1:${server.address().port}`;
const remote = new VesperBrowserClient({ url: address, tokenFile: join(directory, 'engine', 'admin-token') });
let browser;
const result = { product: 'Vesper Browser', author: 'true-utopian', checks: [], screenshots: [], pageErrors: [] };
try {
  await mkdir(output, { recursive: true });
  browser = await puppeteer.launch({ executablePath, headless: true, defaultViewport: { width: 1440, height: 1000 } });
  const page = (await browser.pages())[0];
  page.on('pageerror', error => result.pageErrors.push(error.message));
  await page.goto(address);
  await page.type('#access-token', token); await page.click('#unlock-form button');
  await page.waitForFunction(() => !document.querySelector('#workspace').hidden);
  await page.click('#create'); await page.type('input[name="name"]', 'Research journal');
  await page.type('input[name="locale"]', 'en-GB'); await page.type('input[name="timezone"]', 'America/New_York');
  await page.click('#save'); await page.waitForSelector('.profile-row');
  const id = (await engine.listProfiles())[0].id;
  assert.equal((await engine.readProfile(id)).settings.timezone, 'America/New_York');
  result.checks.push('Authenticated UI profile creation writes actual engine settings');
  await page.click(`.profile-row[data-profile-id="${id}"] button:first-child`);
  await page.waitForFunction(id => document.querySelector(`[data-profile-id="${id}"] .state`).textContent === 'Open', {}, id);
  await remote.ready();
  const owned = await puppeteer.connect({ browserWSEndpoint: await remote.connectionUrl(id), defaultViewport: null });
  try { assert.equal(await (await owned.pages())[0].evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone), 'America/New_York'); }
  finally { await owned.disconnect(); }
  await page.click(`.profile-row[data-profile-id="${id}"] button:first-child`);
  await page.waitForFunction(id => document.querySelector(`[data-profile-id="${id}"] .state`).textContent === 'Stopped', {}, id);
  result.checks.push('UI opens and stops a real Chromium profile');
  const archive = join(directory, 'shared-service.workbench.tgz');
  await remote.export(id, archive);
  const imported = await remote.importProfile(archive);
  await remote.update(imported.id, { name: 'run-service-fixture' });
  assert.equal((await remote.findByRunId('service-fixture')).id, imported.id);
  await remote.install(imported.id); await remote.start(imported.id);
  assert.match(await remote.connectionUrl(imported.id), /^ws:\/\/127\.0\.0\.1:/);
  assert.match((await remote.versions(imported.id)).kernelVersion, /Chrome/);
  await remote.stop(imported.id); await remote.close();
  result.checks.push('Shared-store client lifecycle, CDP, archive transfer and identity lookup');
  await page.click(`.profile-row[data-profile-id="${id}"] button:nth-child(2)`);
  await page.$eval('input[name="name"]', input => { input.value = ''; }); await page.type('input[name="name"]', 'Research journal edited');
  await page.click('#save');
  await page.waitForFunction(() => [...document.querySelectorAll('.profile-name')].some(node => node.textContent === 'Research journal edited'));
  await page.click(`.profile-row[data-profile-id="${id}"] button:nth-child(3)`);
  await page.waitForFunction(() => document.querySelectorAll('.profile-row').length === 3);
  result.checks.push('UI editing and duplication preserve separate profiles');
  await engine.create({ name: 'German catalog', locale: 'de-DE', timezone: 'Europe/Berlin', viewport: { width: 1366, height: 768 }, proxy: { value: 'socks5', extra: { host: '127.0.0.1', port: 9, id: 'fixture-user', secret: 'fixture-secret' } } });
  await engine.create({ name: '<img src=x onerror="alert(1)">', locale: 'en-US', timezone: 'America/Chicago' });
  await page.click('#refresh'); await page.waitForFunction(() => document.querySelectorAll('.profile-row').length === 5);
  assert.equal(await page.$$eval('.profile-row img', nodes => nodes.length), 0);
  result.checks.push('Profile names render as text, never executable HTML');
  await page.type('#search', 'German'); await page.waitForFunction(() => document.querySelectorAll('.profile-row').length === 1);
  await page.$eval('#search', input => { input.value = ''; input.dispatchEvent(new Event('input')); });
  result.checks.push('Search filters actual profiles');
  for (const width of [1440, 800, 390, 320]) {
    await page.setViewport({ width, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `No horizontal overflow at ${width}px`);
    const file = join(output, `profiles-${width}.png`); await page.screenshot({ path: file, fullPage: true }); result.screenshots.push(file);
  }
  await page.click('#create'); await page.waitForFunction(() => document.querySelector('dialog').open);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(output, 'create-320.png'), fullPage: true });
  await page.click('#cancel'); await page.click('#lock'); await page.waitForFunction(() => !document.querySelector('#unlock').hidden);
  result.checks.push('Responsive list/editor at 1440, 800, 390 and 320px; explicit lock removes token');
  assert.deepEqual(result.pageErrors, []);
  result.passed = true;
  await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser?.close(); await new Promise(done => server.close(done)); await engine.close();
  await rm(directory, { recursive: true, force: true });
}
