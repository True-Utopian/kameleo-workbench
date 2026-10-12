import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import * as tar from 'tar';

const results = [];
for (const product of ['browser','workbench']) {
  const version=JSON.parse(await readFile(product==='browser'?'packages/vesper-browser/package.json':'package.json','utf8')).version;
  const file = resolve('release', product, 'linux', `vesper-${product}_${version}_amd64.deb`), bytes = await readFile(file);
  assert.equal(bytes.subarray(0, 8).toString(), '!<arch>\n');
  const members = new Map();
  for (let cursor = 8; cursor < bytes.length;) {
    const header = bytes.subarray(cursor, cursor + 60).toString('ascii'), size = Number(header.slice(48, 58).trim());
    assert.equal(header.slice(58), '\x60\n'); assert.ok(Number.isSafeInteger(size) && size > 0);
    const name = header.slice(0, 16).trim().replace(/\/$/, '');
    members.set(name, bytes.subarray(cursor + 60, cursor + 60 + size)); cursor += 60 + size + (size % 2);
  }
  assert.equal(members.get('debian-binary').toString(), '2.0\n');
  const entries = new Map();
  await new Promise((done, reject) => {
    const listing = tar.t({ onReadEntry: entry => { entries.set(entry.path, { mode: entry.mode, size: entry.size }); entry.resume(); } });
    listing.once('error', reject); listing.once('end', done); Readable.from(members.get('data.tar.gz')).pipe(listing);
  });
  const prefix = `opt/vesper-${product}`;
  assert.equal(entries.get(`${prefix}/vesper-${product}`).mode & 0o7777, 0o755);
  assert.equal(entries.get(`${prefix}/chrome-sandbox`).mode & 0o7777, 0o4755);
  assert.equal(entries.get(`usr/bin/vesper-${product}`).mode & 0o7777, 0o755);
  for (const required of [`${prefix}/resources/app.asar`, `${prefix}/resources/runtime/service.mjs`, `${prefix}/resources/payload/packages/vesper-browser/dist/index.js`, `${prefix}/resources/payload/node_modules/puppeteer-core/package.json`, `${prefix}/resources/icon.png`, `usr/share/applications/vesper-${product}.desktop`]) assert.ok(entries.has(required), `Missing ${required}`);
  assert.equal([...entries.keys()].some(name => name.includes('/node_modules/@kameleo/')), false);
  const elf = await readFile(resolve('release', product, 'linux/linux-unpacked', `vesper-${product}`));
  assert.equal(elf.subarray(0, 4).toString('hex'), '7f454c46'); assert.equal(elf[4], 2); assert.equal(elf.readUInt16LE(18), 62);
  results.push({ product, format: 'deb', architecture: 'amd64', entries: entries.size, bytes: bytes.length, structurePassed: true, nativeExecution: 'unqualified: WSL REGDB_E_CLASSNOTREG, no Linux environment on this PC' });
}
await mkdir('test-results/desktop', { recursive: true }); await writeFile('test-results/desktop/linux-packages.json', JSON.stringify(results, null, 2)); console.log(JSON.stringify(results, null, 2));
