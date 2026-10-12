import test from 'node:test';
import assert from 'node:assert/strict';
import{mkdtemp,mkdir,writeFile,readFile,rm}from'node:fs/promises';
import{tmpdir}from'node:os';import{join}from'node:path';
test('desktop upgrades starter files while preserving user edits and untracked custom examples',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'vesper-seeds-')),payload=join(directory,'payload'),state=join(directory,'state');
 // The shipped ESM helper is part of the actual desktop upgrade path.
 const {seedFiles}=await import('../desktop/seed-files.mjs');
 try{for(const root of [payload,state])for(const folder of ['automations','flows'])await mkdir(join(root,folder),{recursive:true});
 await writeFile(join(payload,'automations/one.mjs'),'v1');await writeFile(join(payload,'automations/two.mjs'),'v1');await seedFiles(payload,state);
 await writeFile(join(state,'automations/two.mjs'),'user edit');await writeFile(join(state,'flows/custom.json'),'custom');
 await writeFile(join(payload,'automations/one.mjs'),'v2');await writeFile(join(payload,'automations/two.mjs'),'v2');await seedFiles(payload,state);
 assert.equal(await readFile(join(state,'automations/one.mjs'),'utf8'),'v2');assert.equal(await readFile(join(state,'automations/two.mjs'),'utf8'),'user edit');assert.equal(await readFile(join(state,'flows/custom.json'),'utf8'),'custom');
 }finally{await rm(directory,{recursive:true,force:true});}
});
