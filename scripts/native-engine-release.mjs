import assert from 'node:assert/strict';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import contract from '../desktop/update-contract.cjs';
import pluginContract from '../desktop/plugin-contract.cjs';

// This manifest is deliberately scoped to the engine follow-up. It does not
// replace the earlier release's broader installed/UI/scheduler acceptance.
const root = resolve(import.meta.dirname, '..');
const json = async path => JSON.parse(await readFile(join(root, path), 'utf8'));
const products = { browser: (await json('packages/vesper-browser/package.json')).version, workbench: (await json('package.json')).version };
const native = await json('test-results/native-engine/qualification.json');
const desktop = await json('test-results/native-engine/desktop-qualification.json');
const linux = await json('test-results/desktop/linux-packages.json');
const audit = await json('test-results/native-engine/production-audit.json');
assert.equal(native.state, 'passed'); assert.deepEqual(native.failures, []);
assert.equal(desktop.state, 'passed'); assert.deepEqual(desktop.errors, []);
assert.deepEqual(desktop.versions, products);
assert.equal(linux.length, 2); assert.ok(linux.every(item => item.structurePassed));
assert.equal(audit.metadata.vulnerabilities.total, 0);
const check = await readFile(join(root, 'test-results/native-engine/check.log'), 'utf8');
const passed = [...check.matchAll(/^ℹ pass (\d+)\r?$/gm)].map(match => Number(match[1]));
const failed = [...check.matchAll(/^ℹ fail (\d+)\r?$/gm)].map(match => Number(match[1]));
assert.equal(passed.length, 2); assert.deepEqual(failed, [0, 0]);
const publicKey = await readFile(join(root, 'desktop/update-public-key.pem'), 'utf8');
const paths = [];
for (const [product, version] of Object.entries(products)) {
  const windows = `${product}/win32/Vesper-${product}-${version}-win32-x64-full.exe`;
  const debian = `${product}/linux/vesper-${product}_${version}_amd64.deb`;
  for (const [path, platform] of [[windows, 'win32'], [debian, 'linux']]) {
    await contract.verifyLocalUpdate(join(root, 'release', path + '.vesper-update.json'), publicKey, { product, platform, arch: 'x64', version: '0.0.0' });
    paths.push(path, path + '.vesper-update.json');
  }
  paths.push(`${product}/linux/Vesper-${product}-${version}-linux-x64.tar.gz`);
}
const addon = `addons/Vesper-workbench-${products.workbench}.vplugin.tgz`;
for (const platform of ['win32', 'linux']) await pluginContract.verifyPlugin(join(root, 'release', addon + '.vesper-plugin.json'), publicKey, { platform, arch: 'x64' });
paths.push(addon, addon + '.vesper-plugin.json', `Vesper-source-${products.workbench}.tar.gz`);
const artifacts = [];
for (const path of paths) {
  const file = join(root, 'release', path);
  artifacts.push({ path, bytes: (await stat(file)).size, sha256: await contract.hashFile(file) });
}
const evidence = [];
for (const path of ['test-results/native-engine/check.log','test-results/native-engine/qualification.json','test-results/native-engine/desktop-qualification.json','test-results/native-engine/production-audit.json','test-results/desktop/linux-packages.json']) evidence.push({ path, sha256: await contract.hashFile(join(root, path)) });
const manifest = {
  schemaVersion: 1, author: 'true-utopian', channel: 'local-development', published: false,
  products, implementation: 'upstream-native-engines-and-cdp', customCompiledKernel: false,
  validation: { sourceTestsPassed: passed.reduce((sum, value) => sum + value, 0), nativeCases: native.checks.length, windowsPackagedPair: true, userInstallationChanged: false, linuxStructure: true, linuxNativeExecution: false, productionVulnerabilities: 0 },
  limitations: ['A custom compiled Vesper masking kernel and vendor feature parity remain unfinished.', 'Windows installers have local signed update manifests but no Authenticode publisher certificate.', 'Current native/privacy qualification is bounded to owned fixtures, builds and this Windows machine.', 'The running user installation remains Browser 0.3.0 / Workbench 0.4.0 until the new local installers/add-on are applied.'],
  artifacts, evidence,
};
const file = join(root, 'release', `NATIVE-ENGINE-${products.browser}.json`);
await writeFile(file, JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ file, products, artifacts: artifacts.length, validation: manifest.validation }, null, 2));
