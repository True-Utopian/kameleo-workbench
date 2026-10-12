import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('detached service writes stdout and stderr after its desktop manager exits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vesper-service-lifecycle-'));
  const log = join(root, 'service.log'), childFile = join(root, 'child.cjs'), parentFile = join(root, 'parent.cjs');
  try {
    await writeFile(childFile, `setTimeout(()=>{console.log('owned stdout after manager exit');console.error('owned stderr after manager exit');},500);`);
    await writeFile(parentFile, `const {forkService}=require(${JSON.stringify(resolve('desktop/service-process.cjs'))});(async()=>{const child=await forkService(process.argv[2],[],{log:process.argv[3],execPath:process.execPath,env:process.env,detached:true});child.disconnect();child.unref();})();`);
    await promisify(execFile)(process.execPath, [parentFile, childFile, log], { windowsHide: true, timeout: 10000 });
    const deadline = Date.now() + 10000; let content = '';
    while (Date.now() < deadline) { content = await readFile(log, 'utf8'); if (content.includes('owned stderr after manager exit')) break; await new Promise(done => setTimeout(done, 25)); }
    assert.match(content, /owned stdout after manager exit/); assert.match(content, /owned stderr after manager exit/); assert.ok(!content.includes('EPIPE'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
