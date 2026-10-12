import assert from 'node:assert/strict';
import { test } from 'node:test';
// The browser's schema classifier runs without DOM dependencies.
// @ts-ignore JS is served directly as a browser module.
import { schemaHasComplexRoot } from '../public/schema-form.js';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareAssets } from '../src/assets.js';

test('Inspect conditional native-policy rules retain ordinary form controls', async () => {
  // A clean source checkout has not emitted Workbench dist before its tests.
  const previousSdk = process.env.VESPER_SDK_MODULE;
  let inspect;
  try {
    process.env.VESPER_SDK_MODULE = new URL('../src/automation.ts', import.meta.url).href;
    inspect = (await import('../automations/inspect.mjs')).default;
  } finally {
    if (previousSdk === undefined) delete process.env.VESPER_SDK_MODULE;
    else process.env.VESPER_SDK_MODULE = previousSdk;
  }
  assert.ok(inspect.inputSchema.allOf);
  assert.equal(schemaHasComplexRoot(inspect.inputSchema), false);
  assert.ok(['webgl', 'audio', 'fonts'].every(key => inspect.inputSchema.properties[key].enum.length === 2));
});

test('cached app module keeps its relative schema dependency and changes revision when that dependency changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vesper-schema-assets-'));
  try {
    const source = join(root, 'source'), cache = join(root, 'cache'); await mkdir(source);
    for (const [name, content] of Object.entries({ 'app.js': "import './schema-form.js';", 'styles.css': 'body{}', 'index.html': '<script type="module" src="/app.js"></script>', 'schema-form.js': 'export const policy=1;' })) await writeFile(join(source, name), content);
    const first = await prepareAssets(source, cache);
    assert.ok(first.html.includes(`/assets/${first.revision}/app.js`));
    assert.equal(await readFile(join(cache, first.revision, 'schema-form.js'), 'utf8'), 'export const policy=1;');
    await writeFile(join(source, 'schema-form.js'), 'export const policy=2;');
    const second = await prepareAssets(source, cache); assert.notEqual(second.revision, first.revision);
    assert.equal(await readFile(join(cache, second.revision, 'schema-form.js'), 'utf8'), 'export const policy=2;');
    assert.equal(await readFile(join(cache, first.revision, 'schema-form.js'), 'utf8'), 'export const policy=1;');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('branch-defined fields and genuinely composite root schemas retain JSON fallback', () => {
  const base = { type: 'object', properties: { engine: { type: 'string' } } };
  for (const rule of [
    { oneOf: [{ required: ['engine'] }] }, { anyOf: [] }, { type: 'array' },
    { allOf: [{ properties: { hidden: { type: 'string' } } }] },
    { allOf: [{ if: { required: ['engine'] }, then: { properties: { hidden: {} } } }] },
    { allOf: [{ if: { required: ['engine'] }, then: { required: ['hidden'] } }] },
    { allOf: [{ if: {}, then: {}, else: { additionalProperties: true } }] },
    { allOf: {} },
  ]) assert.equal(schemaHasComplexRoot({ ...base, ...rule }), true);
  assert.equal(schemaHasComplexRoot({ ...base, allOf: [{ if: { required: ['engine'] }, then: { properties: { engine: { const: 'vesper' } } } }] }), false);
});
