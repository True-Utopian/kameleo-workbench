import assert from 'node:assert/strict';
import {test} from 'node:test';
import Ajv from 'ajv';
import {validateFingerprint} from '@true-utopian/vesper-browser';

// Exercise the real automation using its supported SDK module override. A clean
// source test checkout has not emitted the Workbench dist tree yet.
const previousSdk=process.env.VESPER_SDK_MODULE;
let inspect;
try {
  process.env.VESPER_SDK_MODULE=new URL('../src/automation.ts',import.meta.url).href;
  inspect=(await import('../automations/inspect.mjs')).default;
} finally {
  if(previousSdk===undefined)delete process.env.VESPER_SDK_MODULE;
  else process.env.VESPER_SDK_MODULE=previousSdk;
}

test('Workbench inspect forwards qualified native controls and rejects incompatible input combinations',()=>{
  const validate=new Ajv({strict:false}).compile(inspect.inputSchema);
  const inputs={url:'http://127.0.0.1/',engine:'vesper',protection:'default',webgl:'restricted',audio:'seeded',fonts:'restricted'};
  assert.equal(validate(inputs),true);
  const profile=inspect.profile({inputs});
  assert.equal(profile.engine,'vesper');
  assert.deepEqual(validateFingerprint(profile.fingerprint),{protection:'standard',webgl:'restricted',audio:'seeded',fonts:'restricted'});
  for(const invalid of [{...inputs,engine:'brave'},{...inputs,engine:'chromium'},{...inputs,protection:'off'},{...inputs,audio:'random'}])assert.equal(validate(invalid),false);
  const ordinary={...inputs,engine:'brave',protection:'standard',webgl:'upstream',audio:'upstream',fonts:'upstream'};
  assert.equal(validate(ordinary),true);
  assert.deepEqual(inspect.profile({inputs:ordinary}).fingerprint,{protection:'standard'});
});
