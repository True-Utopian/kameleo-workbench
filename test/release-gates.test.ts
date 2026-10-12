import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateReleaseGates, collectReleaseEvidence } from '../scripts/release-gates.mjs';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';

const versions = { browser: '0.4.4', workbench: '0.5.6' }, sha = '1'.repeat(64);
function evidence() {
  const accepted = { state: 'passed', errors: [], versions };
  const surfacePolicies = ['webgl-debug-restriction','offline-audio-seed','local-font-discovery'];
  const proof = { state: 'passed', errors: [], nativeProof: true, implementation: 'native-chromium-patches', executableSha256: sha, surfacePolicies, cases: ['baseline','seed-a','seed-a-restart','seed-b','invalid-fallback','surface-policy-a','surface-policy-a-restart','surface-policy-b','surface-policy-invalid'].map(name => ({ name })) };
  const publicCommit = { main: 'commit', workflow: { sha: 'commit', status: 'completed', conclusion: 'success' } };
  return { versions, status: { groups: [{ checks: [{ id: 'owned-feature', state: 'verified' }] }] }, source: { suites: 2, passed: 151, failed: 0 }, packaged: accepted, installed: accepted, proxies: { ...accepted, actualInstalledProof: true, proxyRequests: 1, run: { state: 'saved', sha256: sha, archiveBytes: 65000 } }, ui: { state: 'passed', versions, originalMothIconVisible: true, nativeEmbeddedWorkbench: true }, python: { state: 'passed', version: versions.workbench, calendarDSTPreview: true, futureScheduleCreatedPausedRemoved: true }, audit: { metadata: { vulnerabilities: { total: 0 } } }, kernel: { revision: 'pinned' }, build: { revision: 'pinned', customKernelCompiled: true, status: 'compiled-awaiting-native-qualification', executableSha256: sha }, currentExecutableSha256: sha, units: { revision: 'pinned', status: 'native-unit-tests-passed', nativeTestExecutions: 26 }, unitXmlVerified: true, direct: proof, copied: { revision: 'pinned', executableSha256: sha, nativeUnitExecutions: 26, qualification: proof }, runtimeFilesVerified: true, integration: { ...accepted, surfacePolicies, nativeProof: true, installedKernelChanged: true, executableSha256: sha, run: { state: 'saved' } }, linux: { ...accepted, platform: 'linux', installerExecuted: true, sandboxVerified: true, nativeKernelQualified: true }, publication: { browser: publicCommit, workbench: publicCommit } };
}
const pending = (result: any, id: string) => assert.equal(result.gates.find((gate: any) => gate.id === id).state, 'pending');

test('legacy scalar/canvas receipts cannot qualify the new native surface release', () => {
  const proof = evidence().direct;
  for (const invalid of [
    { ...proof, surfacePolicies: [] },
    ...proof.surfacePolicies.map(missing => ({ ...proof, surfacePolicies: proof.surfacePolicies.filter(policy => policy !== missing) })),
    ...proof.cases.filter(record => record.name.startsWith('surface-policy')).map(missing => ({ ...proof, cases: proof.cases.filter(record => record.name !== missing.name) })),
  ]) {
    const input = evidence(); input.direct = invalid; input.copied.qualification = invalid;
    const result = evaluateReleaseGates(input);
    assert.equal(result.productComplete, false);
    pending(result, 'direct-native-proof'); pending(result, 'copied-native-runtime');
  }
  const input = evidence(); input.integration.surfacePolicies = ['offline-audio-seed'];
  pending(evaluateReleaseGates(input), 'installed-native-integration');
});

test('installed proxy acceptance requires current installed routing and a saved verified archive', () => {
  const proxyProof = evidence().proxies;
  for (const invalid of [undefined, { ...proxyProof, actualInstalledProof: false }, { ...proxyProof, versions: { browser: '0.4.3', workbench: '0.5.5' } }, { ...proxyProof, errors: ['preservation failed'] }, { ...proxyProof, proxyRequests: 0 }, { ...proxyProof, run: { ...proxyProof.run, state: 'running' } }, { ...proxyProof, run: { ...proxyProof.run, sha256: 'unverified' } }, { ...proxyProof, run: { ...proxyProof.run, archiveBytes: 0 } }]) {
    const result = evaluateReleaseGates({ ...evidence(), proxies: invalid });
    assert.equal(result.productComplete, false); pending(result, 'actual-installed-proxies');
  }
});

test('release acceptance rejects older installed/UI/SDK evidence and package-only Linux checks', () => {
  const input = evidence(); input.installed = { ...input.installed, versions: { browser: '0.4.3', workbench: '0.5.5' } }; input.ui = { ...input.ui, versions: input.installed.versions }; input.python.version = '0.5.5'; input.linux = { ...input.linux, platform: 'win32', installerExecuted: false };
  const result = evaluateReleaseGates(input); assert.equal(result.productComplete, false);
  for (const id of ['actual-installed-pair','actual-installed-ui','actual-installed-python','linux-native-runtime']) pending(result,id);
});
test('a build, CDP proof, changed executable/components or stale CI cannot complete the native release', () => {
  const input = evidence(); input.currentExecutableSha256 = '2'.repeat(64); input.direct.implementation = 'upstream-native-engines-and-cdp'; input.runtimeFilesVerified = false; input.publication.browser.workflow.sha = 'older';
  const result = evaluateReleaseGates(input); assert.equal(result.productComplete, false);
  for (const id of ['native-compilation','native-unit-tests','direct-native-proof','copied-native-runtime','installed-native-integration','public-source-ci']) pending(result,id);
});
test('all named features, native XML executions and exact runtime integration are required', () => {
  const input = evidence(); assert.equal(evaluateReleaseGates(input).productComplete,true);
  input.status.groups[0].checks[0].state = 'source_tested'; input.unitXmlVerified = false; input.integration.run.state = 'running';
  const result = evaluateReleaseGates(input); assert.equal(result.productComplete,false);
  for (const id of ['implemented-roadmap','native-unit-tests','installed-native-integration']) pending(result,id);
  input.status.groups[0].checks.push({ id: 'owned-feature', state: 'verified' }); assert.throws(() => evaluateReleaseGates(input),/duplicate/);
});
test('evidence collection verifies the executable and rejects stale or failed native XML', async () => {
  const root = await mkdtemp(join(tmpdir(),'vesper-release-audit-'));
  const save = async (path: string, value: any) => { await mkdir(dirname(join(root,path)),{recursive:true}); await writeFile(join(root,path),typeof value === 'string' ? value : JSON.stringify(value)); };
  try {
    const bytes = 'owned non-browser audit fixture', executable = join(root,'owned.exe'); await writeFile(executable,bytes);
    await save('package.json',{version:versions.workbench}); await save('packages/vesper-browser/package.json',{version:versions.browser});
    await save('test-results/proxy-inventory/installed-pair.json',evidence().proxies);
    await save('.workbench/kernel-toolchain/build-result.json','\uFEFF'+JSON.stringify({...evidence().build,executable,executableSha256:createHash('sha256').update(bytes).digest('hex')}));
    await save('.workbench/kernel-toolchain/test-result.json',{...evidence().units,at:new Date().toISOString()});
    for (const [name,count] of [['upstream-memory-regression',1],['scalars-default',8],['scalars-policy',8],['canvas',9]]) await save(`.workbench/kernel-toolchain/${name}.xml`,`<testsuites tests="${count}" failures="0" disabled="0" errors="0"></testsuites>`);
    const initial = await collectReleaseEvidence(root); assert.equal(initial.unitXmlVerified,true); assert.equal(initial.currentExecutableSha256,initial.build.executableSha256); assert.equal(initial.runtimeFilesVerified,false); assert.deepEqual(initial.proxies,evidence().proxies);
    await utimes(join(root,'.workbench/kernel-toolchain/canvas.xml'),new Date(0),new Date(0)); assert.equal((await collectReleaseEvidence(root)).unitXmlVerified,false);
    await save('.workbench/kernel-toolchain/canvas.xml','<testsuites tests="9" failures="0" errors="1"><error/></testsuites>'); assert.equal((await collectReleaseEvidence(root)).unitXmlVerified,false);
    await writeFile(executable,'changed owned fixture'); const changed=await collectReleaseEvidence(root); assert.notEqual(changed.currentExecutableSha256,changed.build.executableSha256);
  } finally { await rm(root,{recursive:true,force:true}); }
});
