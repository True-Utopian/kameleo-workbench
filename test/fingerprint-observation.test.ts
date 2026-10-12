import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessFingerprintConsistency } from '../scripts/lib/fingerprint-observation.mjs';
const sample=()=>({userAgent:'OwnedBrowser/157',platform:'Win32',language:'en-US',languages:['en-US'],cpu:4,memory:8,timezone:'Europe/London',userAgentData:{brands:[{brand:'Chromium',version:'157'},{brand:'Owned Browser',version:'157'}],mobile:false,platform:'Windows'},canvas:{first:'owned-digest',repeat:'owned-digest'},webgl:{unmaskedVendor:'Owned vendor',unmaskedRenderer:'Owned renderer',maxTextureSize:4096}});
const request=()=>({userAgent:'OwnedBrowser/157',platform:'"Windows"',brands:'"Owned Browser";v="157", "Chromium";v="157"'});
test('consistent owned observations remain observations and do not qualify masking',()=>{const result=assessFingerprintConsistency({main:sample(),worker:sample()},[request()]);assert.equal(result.mismatches.length,0);assert.equal(result.nativeProof,false);assert.ok(result.unsupportedMaskingSurfaces.includes('audio-masking'));});
test('worker scalar and graphics contradictions are exposed separately',()=>{const worker=sample();worker.cpu=12;worker.webgl.unmaskedRenderer='Different renderer';const result=assessFingerprintConsistency({main:sample(),worker},[request()]);assert.deepEqual(result.mismatches.map(check=>check.id),['worker:cpu','worker:webgl-unmaskedRenderer']);});
test('HTTP and navigator client hints cannot silently disagree',()=>{const headers=request();headers.platform='"Linux"';headers.brands='"Chromium";v="156"';headers.userAgent='DifferentBrowser/156';const result=assessFingerprintConsistency({main:sample()},[headers]);assert.deepEqual(result.mismatches.map(check=>check.id),['request-0:user-agent','request-0:platform','request-0:brands']);});
test('missing optional APIs and changing read-out results are not fabricated into passes',()=>{const worker={...sample(),canvas:{first:'first',repeat:'second'},webgl:null};const result=assessFingerprintConsistency({main:sample(),worker},[]);assert.deepEqual(result.mismatches.map(check=>check.id),['worker:canvas-repeat','worker:canvas-context']);assert.ok(!result.checks.some(check=>check.id==='worker:webgl-unmaskedRenderer'));assert.throws(()=>assessFingerprintConsistency({},[]),/main document/);});
test('a consistently contradictory Chrome identity fails even when every context agrees',()=>{const main={...sample(),userAgent:'Mozilla/5.0 Chrome/156.0.0.0 Safari/537.36'};const result=assessFingerprintConsistency({main,worker:structuredClone(main)},[]);assert.deepEqual(result.mismatches.map(check=>check.id),['main:chrome-brand-version','worker:chrome-brand-version']);});

test('matching WebGL names cannot hide broken pixel reads, crops or PNG exports',()=>{
  const readout={first:'gpu',repeat:'gpu',crop:'crop',expectedCrop:'crop',topDown:'flipped',blobPixels:'flipped',dataUrlPixels:'flipped',error:0};
  const main={...sample(),webgl:{...sample().webgl,readout},webgl2:{readout:structuredClone(readout)}};
  const worker=structuredClone(main);worker.webgl.readout.first='other-gpu';worker.webgl.readout.crop='wrong-crop';worker.webgl.readout.blobPixels='unprotected';worker.webgl2.readout.error=1282;
  const result=assessFingerprintConsistency({main,worker},[]);
  assert.deepEqual(result.mismatches.map(check=>check.id),['worker:webgl-repeat','worker:webgl-crop','worker:webgl-context','worker:webgl-blobPixels','worker:webgl2-read-error']);
  assert.equal(result.nativeProof,false);
});

test('Canvas2D exports and audio channel copies are checked within one context',()=>{
  const main={...sample(),canvas:{first:'pixels',repeat:'pixels',crop:'crop',expectedCrop:'crop',blobPixels:'different',dataUrlPixels:'pixels'},audio:{hash:'audio',repeat:'changed',copy:'unprotected'}};
  const result=assessFingerprintConsistency({main},[]);
  assert.deepEqual(result.mismatches.map(check=>check.id),['main:canvas-blob','main:audio-repeat','main:audio-copy']);
});

test('an available API throwing during observation is a mismatch, not missing support',()=>{
  const main={...sample(),webgl:null,errors:[{surface:'webgl',message:'OperationError'}]};
  assert.deepEqual(assessFingerprintConsistency({main},[]).mismatches.map(check=>check.id),['main:webgl-observation']);
});
