import assert from 'node:assert/strict';
import {test} from 'node:test';
import Ajv from 'ajv';
import inspect from '../automations/inspect.mjs';
import {validateFingerprint} from '@true-utopian/vesper-browser';

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
