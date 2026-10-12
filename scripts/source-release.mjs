import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import * as tar from 'tar';

const root = resolve(import.meta.dirname, '..');
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const output = join(root, 'release');
await mkdir(output, { recursive: true });
// Explicit public inputs: never walk the workspace root or private browser stores.
const inputs = ['README.md', 'LICENSE', 'package.json', 'package-lock.json',
  'tsconfig.json', '.env.example', '.gitignore', '.gitattributes', 'vesper.local.env', 'compose.yaml',
  'Dockerfile', '.dockerignore', '.github', 'src', 'public', 'packages/vesper-browser',
  'desktop', 'native', 'sdks', 'scripts', 'schemas', 'automations', 'flows', 'docs', 'test'];
const existing = [];
for (const input of inputs) {
  try { await stat(join(root, input)); existing.push(input); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const filename = `Vesper-source-${version}.tar.gz`, file = join(output, filename);
const excluded = /(^|\/)(node_modules|dist|__pycache__|\.git|\.workbench|\.vesper|test-results|release|\.desktop-build)(\/|$)/;
await tar.c({ cwd: root, file, gzip: true, portable: true, noMtime: true,
  filter: (name, entry) => !excluded.test(name.replaceAll('\\', '/'))
    && !entry.isSymbolicLink() && !/\.pyc$/.test(name)
}, existing);
const entries = [];
await tar.t({ file, onReadEntry: entry => entries.push(entry.path) });
if (!entries.includes('src/cli.ts') || !entries.includes('packages/vesper-browser/src/server.ts')) throw new Error('Incomplete source archive');
if (entries.some(name => excluded.test(name) || /(^|\/)(admin-token|\.env)$/.test(name))) throw new Error('Private input entered source archive');
const hash = createHash('sha256');
for await (const chunk of createReadStream(file)) hash.update(chunk);
await writeFile(join(output, 'SOURCE-SHA256SUMS'), `${hash.digest('hex')}  ${filename}\n`);
console.log(`${file}: ${entries.length} public source entries`);
