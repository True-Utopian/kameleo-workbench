import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';
import * as tar from 'tar';

const require = createRequire(import.meta.url);
const { canonical } = require('../desktop/update-contract.cjs');
const { permissions, verifyPlugin, installPlugin, readInstalled } = require('../desktop/plugin-contract.cjs');
const contractFile = resolve('desktop/plugin-contract.cjs');
const execute = promisify(execFile);
const current = { platform: process.platform, arch: process.arch };
const required = ['runtime/service.mjs', 'payload/dist/cli.js', 'payload/dist/index.js', 'payload/public/index.html', 'payload/package.json'];
const { publicKey, privateKey } = generateKeyPairSync('ed25519');

type Member = { path: string; type?: string; size?: number; linkpath?: string; data?: string };
function archive(members: Member[]) {
  const blocks: Buffer[] = [];
  for (const member of members) {
    const content = Buffer.from(member.data ?? 'fixture');
    const header = new tar.Header({ path: member.path, type: (member.type ?? 'File') as any, mode: 0o600, uid: 0, gid: 0, size: member.size ?? content.length, linkpath: member.linkpath });
    header.encode(); blocks.push(header.block!);
    // Oversized declared members intentionally omit their data; rejection must happen at the header.
    if (member.size === undefined) { blocks.push(content); if (content.length % 512) blocks.push(Buffer.alloc(512 - content.length % 512)); }
  }
  blocks.push(Buffer.alloc(1024)); return gzipSync(Buffer.concat(blocks));
}
const goodArchive = () => archive(required.map(path => ({ path })));

async function signedFixture(directory: string, bytes = goodArchive()) {
  await mkdir(directory, { recursive: true });
  const payload = {
    schemaVersion: 1, id: 'workbench', name: 'Vesper Workbench', publisher: 'true-utopian',
    version: '0.3.1', hostApiVersion: '1.0', platforms: ['win32', 'linux'], arch: process.arch,
    permissions, filename: 'Vesper-workbench-0.3.1.vplugin.tgz', bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  const manifest = { ...payload, signature: sign(null, Buffer.from(canonical(payload)), privateKey).toString('base64') };
  const file = join(directory, 'workbench-plugin.json');
  await writeFile(join(directory, payload.filename), bytes); await writeFile(file, JSON.stringify(manifest));
  return { file, manifest, archiveFile: join(directory, payload.filename) };
}

test('signed local Workbench add-on verifies, installs and reloads its registry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vesper-signed-plugin-'));
  try {
    const fixture = await signedFixture(join(directory, 'release'));
    const verified = await verifyPlugin(fixture.file, publicKey, current);
    assert.equal(verified.publisher, 'true-utopian'); assert.equal(verified.file, fixture.archiveFile);
    const base = join(directory, 'browser-store');
    assert.equal(await readInstalled(base), undefined);
    const installed = await installPlugin(verified, base, tar);
    assert.equal(installed.enabled, true); assert.equal(installed.version, '0.3.1');
    assert.deepEqual(await readInstalled(base), installed);
    for (const file of required) assert.equal(await readFile(join(installed.directory, file), 'utf8'), 'fixture');
    const second = await installPlugin(verified, base, tar);
    assert.notEqual(second.directory, installed.directory, 'A replacement must not overwrite the previous installation');
    assert.equal((await readInstalled(base)).directory, second.directory);
    assert.equal(await readFile(join(installed.directory, 'runtime/service.mjs'), 'utf8'), 'fixture');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('untrusted keys, modified signed metadata and changed archive bytes are rejected', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vesper-plugin-trust-'));
  try {
    const fixture = await signedFixture(directory);
    const other = generateKeyPairSync('ed25519');
    await assert.rejects(verifyPlugin(fixture.file, other.publicKey, current), /signature.*not trusted/);
    await writeFile(fixture.file, JSON.stringify({ ...fixture.manifest, version: '0.3.2', filename: 'Vesper-workbench-0.3.2.vplugin.tgz' }));
    await assert.rejects(verifyPlugin(fixture.file, publicKey, current), /signature.*not trusted/);
    await writeFile(fixture.file, JSON.stringify(fixture.manifest));
    const changed = await readFile(fixture.archiveFile); changed[Math.floor(changed.length / 2)]! ^= 1;
    await writeFile(fixture.archiveFile, changed);
    await assert.rejects(verifyPlugin(fixture.file, publicKey, current), /contents.*signed manifest/);
    assert.equal(await readInstalled(join(directory, 'store')), undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// Keep parser callback failures in a child process: a rejection is acceptable, an uncaught
// exception or a parser hang is a regression and must not crash the other contract tests.
async function rejectedInstall(fixture: Awaited<ReturnType<typeof signedFixture>>, base: string, expected: RegExp) {
  const program = `
    const { installPlugin } = require(process.argv[1]);
    const tar = require('tar');
    installPlugin({file:process.argv[2],version:'0.3.1',sha256:process.argv[4]},process.argv[3],tar)
      .then(() => { console.error('Unsafe archive was installed'); process.exitCode=3; })
      .catch(error => process.stdout.write(JSON.stringify({rejected:true,error:error.message})));`;
  let output: { stdout: string; stderr: string };
  try { output = await execute(process.execPath, ['-e', program, contractFile, fixture.archiveFile, base, fixture.manifest.sha256], { timeout: 10000, windowsHide: true }); }
  catch (error) { const failure = error as Error & { stderr?: string; code?: number | string }; assert.fail(`Archive preflight did not reject safely (exit ${failure.code ?? 'unknown'}):\n${(failure.stderr ?? failure.message).slice(0, 1400)}`); }
  const result = JSON.parse(output!.stdout);
  assert.equal(result.rejected, true); assert.match(result.error, expected);
  assert.equal(await readInstalled(base), undefined, 'Rejected archives must not register an installation');
}

test('archive preflight safely rejects traversal, links, duplicate names and missing runtime', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'vesper-plugin-paths-'));
  const cases: { name: string; members: Member[]; expected: RegExp }[] = [
    { name: 'parent traversal', members: [{ path: 'payload/../../outside.txt' }], expected: /Unsafe.*path/ },
    { name: 'absolute path', members: [{ path: '/payload/outside.txt' }], expected: /Unsafe.*path/ },
    { name: 'backslash traversal', members: [{ path: 'payload\\..\\outside.txt' }], expected: /Unsafe.*path/ },
    { name: 'Windows reserved member', members: [{ path: 'payload/CON.txt' }], expected: /Unsafe.*path/ },
    { name: 'unrecognized root', members: [{ path: 'outside.txt' }], expected: /Unexpected.*root/ },
    { name: 'symbolic link', members: [{ path: 'payload/link', type: 'SymbolicLink', linkpath: '../../outside' }], expected: /Unsafe.*archive/ },
    { name: 'hard link', members: [{ path: 'payload/link', type: 'Link', linkpath: '../../outside' }], expected: /Unsafe.*archive/ },
    { name: 'case-colliding member', members: [{ path: 'payload/a.js' }, { path: 'payload/A.js' }], expected: /Unsafe.*archive/ },
    { name: 'missing service', members: required.filter(path => path !== 'runtime/service.mjs').map(path => ({ path })), expected: /missing runtime\/service\.mjs/ },
  ];
  try {
    for (const [index, value] of cases.entries()) await t.test(value.name, async () => {
      const fixture = await signedFixture(join(directory, `release-${index}`), archive(value.members));
      await rejectedInstall(fixture, join(directory, `store-${index}`), value.expected);
    });
    assert.equal((await readdir(directory)).some(name => name === 'outside.txt'), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('archive preflight rejects excessive member count and declared expanded bytes before extraction', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'vesper-plugin-limits-'));
  try {
    await t.test('member limit', async () => {
      const fixture = await signedFixture(join(directory, 'members'), archive(Array.from({ length: 50001 }, (_, index) => ({ path: `payload/m${index}`, data: '' }))));
      await rejectedInstall(fixture, join(directory, 'member-store'), /Unsafe or oversized/);
    });
    await t.test('declared size limit', async () => {
      const fixture = await signedFixture(join(directory, 'expanded'), archive([{ path: 'payload/huge', size: 600 * 1024 ** 2 + 1 }]));
      await rejectedInstall(fixture, join(directory, 'expanded-store'), /Unsafe or oversized/);
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('installed registry rejects lexical and realpath escapes from its versions store', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vesper-plugin-registry-'));
  const base = join(directory, 'store'), root = join(base, 'plugins', 'workbench'), versions = join(root, 'versions');
  try {
    await mkdir(versions, { recursive: true });
    const registry = join(root, 'installed.json');
    for (const target of [join(directory, 'outside'), join(versions, 'version', 'nested'), versions]) {
      await writeFile(registry, JSON.stringify({ schemaVersion: 1, version: '0.3.1', enabled: true, directory: target }));
      await assert.rejects(readInstalled(base), /Invalid installed add-on registry/);
    }
    const outside = join(directory, 'outside'); await mkdir(join(outside, 'runtime'), { recursive: true }); await mkdir(join(outside, 'payload', 'dist'), { recursive: true });
    await writeFile(join(outside, 'runtime', 'service.mjs'), 'fixture'); await writeFile(join(outside, 'payload', 'dist', 'cli.js'), 'fixture');
    const linked = join(versions, 'linked-version'); await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
    await writeFile(registry, JSON.stringify({ schemaVersion: 1, version: '0.3.1', enabled: true, directory: linked }));
    await assert.rejects(readInstalled(base), /escapes its store/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('source archive replaced after preflight cannot change the private installation snapshot', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vesper-plugin-changed-'));
  try {
    const fixture = await signedFixture(join(directory, 'release'));
    const verified = await verifyPlugin(fixture.file, publicKey, current);
    const base = join(directory, 'store');
    const installed = await installPlugin(verified, base, tar);
    let extractedFile: string | undefined;
    const mutatingTar = {
      ...tar,
      async x(options: { file: string; cwd: string }) {
        extractedFile = options.file;
        const changed = await readFile(fixture.archiveFile); changed[changed.length - 1]! ^= 1;
        await writeFile(fixture.archiveFile, changed);
        await tar.x(options);
      },
    };
    const replacement = await installPlugin(verified, base, mutatingTar);
    assert.notEqual(extractedFile, fixture.archiveFile, 'Extraction must use the verified private snapshot');
    assert.notEqual(replacement.directory, installed.directory);
    assert.deepEqual(await readInstalled(base), replacement);
    for (const file of required) assert.equal(await readFile(join(replacement.directory, file), 'utf8'), 'fixture');
    await assert.rejects(verifyPlugin(fixture.file, publicKey, current), /contents.*signed manifest/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
