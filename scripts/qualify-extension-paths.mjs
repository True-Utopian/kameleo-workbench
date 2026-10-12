import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, resolve } from 'node:path';
import { createServer } from 'node:http';
import puppeteer from 'puppeteer-core';
import { VesperBrowser } from '../packages/vesper-browser/dist/browser.js';
import { extensionZip } from './fixtures/extension-package.mjs';

const index = process.argv.indexOf('--executable');
assert.ok(index >= 0 && process.argv[index + 1], 'Provide --executable <owned Chromium binary>');
const root = await mkdtemp(join(tmpdir(), 'vesper-long-extension-'));
const directory = join(root, 'profile-store-' + 'a'.repeat(65));
const browser = new VesperBrowser({ directory, executablePath: resolve(process.argv[index + 1]), headless: process.argv.includes('--headless') });
const report = { at: new Date().toISOString(), state: 'running', errors: [] };
const fixture = createServer((_request, response) => { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><title>Owned long-path extension fixture</title><h1>Vesper by true-utopian</h1>'); });
await new Promise(done => fixture.listen(0, '127.0.0.1', done));
let profile, connection;
try {
  const file = join(root, 'fixture.zip'); await writeFile(file, extensionZip());
  const extension = await browser.installExtension(file);
  profile = await browser.create({ extensions: [extension.id], locale: 'fr-FR', environment: { hardwareConcurrency: 4 } });
  const manifest = join(directory, 'profiles', profile.id, 'browser', '.vesper-extensions', extension.id, 'manifest.json');
  assert.ok(manifest.length > 260); await readFile(manifest);
  const observations = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    await browser.start(profile.id);
    connection = await puppeteer.connect({ browserWSEndpoint: await browser.connectionUrl(profile.id), defaultViewport: null });
    const page = await connection.newPage(); await page.goto(`http://127.0.0.1:${fixture.address().port}`);
    try { await page.waitForFunction(() => document.documentElement.dataset.vesperExtension || document.documentElement.dataset.vesperExtensionError, { timeout: 20000 }); }
    catch (error) { report.diagnostic = { targets: connection.targets().map(target => ({ type: target.type(), url: target.url() })), document: await page.evaluate(() => ({ title: document.title, dataset: { ...document.documentElement.dataset } })) }; throw error; }
    assert.equal(await page.evaluate(() => document.documentElement.dataset.vesperExtensionError), undefined);
    const observation = await page.evaluate(() => JSON.parse(document.documentElement.dataset.vesperExtension));
    assert.equal(observation.content.cpu, 4); assert.equal(observation.first.language, 'fr-FR'); assert.equal(observation.visits, attempt + 1);
    observations.push(observation); await connection.disconnect(); connection = undefined; await browser.stop(profile.id);
  }
  await readFile(manifest); report.state = 'passed'; report.manifestPathCharacters = manifest.length; report.observations = observations;
} catch (error) { report.state = 'failed'; report.errors.push(error.stack || String(error)); process.exitCode = 1; }
finally {
  await connection?.disconnect().catch(() => {}); if (profile) await browser.stop(profile.id).catch(() => {}); await browser.close();
  await new Promise(done => fixture.close(done));
  const inside = relative(await realpath(tmpdir()), await realpath(root)); assert.ok(inside.startsWith('vesper-long-extension-') && !inside.startsWith('..') && !isAbsolute(inside));
  await rm(root, { recursive: true, force: true }); await mkdir('test-results/extensions', { recursive: true });
  await writeFile('test-results/extensions/long-path-qualification.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
}
