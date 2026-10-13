import assert from 'node:assert/strict';
import {createServer as httpServer} from 'node:http';
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import puppeteer from 'puppeteer-core';
import {VesperBrowser,VesperBrowserClient,browserAccessToken,createBrowserServer} from '../packages/vesper-browser/dist/index.js';
import {nativeExecutableHash,verifyNativeRuntime} from '../packages/vesper-browser/dist/native-kernel.js';
import {Runtime} from '../dist/runtime.js';
import {createServer} from '../dist/server.js';
import {loadConfig} from '../dist/config.js';

const option=name=>{const index=process.argv.indexOf(name);return index<0?undefined:process.argv[index+1];};
const manifestPath=resolve(option('--manifest')??''),output=resolve(option('--output')??'test-results/native-identity/qualification.json');
assert.ok(option('--manifest'),'Provide a qualified native bundle manifest');
const manifest=JSON.parse(await readFile(manifestPath,'utf8')),executablePath=resolve(dirname(manifestPath),manifest.executable);
assert.equal(manifest.qualification.state,'passed');assert.equal(manifest.qualification.nativeProof,true);
assert.equal(await nativeExecutableHash(executablePath),manifest.executableSha256);await verifyNativeRuntime(executablePath,manifest.runtimeFiles);
const root=await mkdtemp(join(tmpdir(),'vesper-native-identity-'));
await mkdir(join(root,'browser'));await writeFile(join(root,'browser/selected-native-kernel.json'),JSON.stringify({executablePath,runtimeFiles:manifest.runtimeFiles,qualification:manifest.qualification}));
const owner=new VesperBrowser({directory:join(root,'browser'),executablePath,headless:!process.argv.includes('--headed'),maxConcurrency:2});
const token=await browserAccessToken(join(root,'browser')),manager=await createBrowserServer(owner,token);
const listen=server=>new Promise(done=>server.listen(0,'127.0.0.1',done));
const snapshot=`({cpu:navigator.hardwareConcurrency,memory:navigator.deviceMemory,userAgent:navigator.userAgent,platform:navigator.platform})`;
const fixture=httpServer((req,res)=>{
  res.setHeader('Accept-CH','Sec-CH-Device-Memory, Device-Memory, Sec-CH-UA-Full-Version-List');
  if(req.url==='/headers'){res.setHeader('content-type','application/json');res.end(JSON.stringify(req.headers));return;}
  if(req.url==='/worker.js'){res.setHeader('content-type','text/javascript');res.end('postMessage('+snapshot+')');return;}
  res.setHeader('content-type','text/html');res.end('<title>Owned native identity</title><script>window.firstIdentity='+snapshot+'</script><p>Owned local identity fixture.</p>');
});
let runtime,workbench,client,attached;
const report={at:new Date().toISOString(),author:'true-utopian',state:'running',nativeProof:false,installedProof:false,versions:{browser:JSON.parse(await readFile(new URL('../packages/vesper-browser/package.json',import.meta.url),'utf8')).version,workbench:JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version},executableSha256:manifest.executableSha256,checks:[],errors:[],cases:[],scope:'Fresh owned stores; native hardware presets, page audit, HTTP client hints, frame and dedicated worker, restart/archive and Browser–Workbench Inspect. Not complete vendor parity or all fingerprint surfaces.'};
async function waitRun(id,state){const deadline=Date.now()+90000;while(Date.now()<deadline){const run=runtime.get(id);if(run.state===state)return run;assert.ok(!['failed','cancelled','interrupted','export_failed'].includes(run.state),'Run failed: '+run.state);await new Promise(done=>setTimeout(done,100));}throw Error('Run did not reach '+state);}
try {
  await listen(manager);await listen(fixture);
  const browserUrl='http://127.0.0.1:'+manager.address().port,url='http://127.0.0.1:'+fixture.address().port+'/';
  client=new VesperBrowserClient({url:browserUrl,tokenFile:join(root,'browser/admin-token')});
  const config=await loadConfig({WORKBENCH_TOKEN:'synthetic-identity-pair-access-token',WORKBENCH_DATA_DIR:join(root,'workbench'),EXPORT_DIR:join(root,'exports'),VESPER_BROWSER_URL:browserUrl,VESPER_BROWSER_TOKEN_FILE:join(root,'browser/admin-token')});
  runtime=new Runtime({...config,engine:client});await runtime.init();workbench=await createServer(config,runtime,{publicInventory:()=>[]},client);
  const workbenchUrl=await workbench.listen({host:'127.0.0.1',port:0});
  for(const value of [4,8]){
    const {id}=await client.create({name:'Owned identity '+value,engine:'vesper',identityPreset:'desktop-'+value,locale:'en-GB',timezone:'Europe/London',fingerprint:{protection:'standard',webgl:'restricted',audio:'seeded',fonts:'restricted'}});
    await client.start(id);attached=await puppeteer.connect({browserWSEndpoint:await client.connectionUrl(id),defaultViewport:null});
    const page=await attached.newPage();await page.goto(url,{waitUntil:'domcontentloaded'});
    const first=await page.evaluate(()=>window.firstIdentity);assert.equal(first.cpu,value);assert.equal(first.memory,value);
    const worker=await page.evaluate(()=>new Promise((done,reject)=>{const worker=new Worker('/worker.js');worker.onmessage=event=>{worker.terminate();done(event.data);};worker.onerror=()=>{worker.terminate();reject(Error('Worker failed'));};}));
    assert.deepEqual(worker,first);
    const frame=await page.evaluate(()=>new Promise((done,reject)=>{const frame=document.createElement('iframe');frame.src='/frame';frame.onload=()=>{try{done(frame.contentWindow.firstIdentity);}catch(error){reject(error);}};document.body.append(frame);}));assert.deepEqual(frame,first);
    const headers=await page.evaluate(()=>fetch('/headers').then(response=>response.json()));assert.equal(Number(headers['sec-ch-device-memory']),value);assert.equal(headers['user-agent'],first.userAgent);
    const observed=await owner.environmentReport(id);assert.equal(observed.identity.state,'passed',JSON.stringify(observed.identity));
    const hintList=observed.clientHints.fullVersionList.filter(item=>item.brand==='Chromium');assert.ok(hintList.length===1);assert.ok(headers['sec-ch-ua-full-version-list'].includes('"Chromium";v="'+hintList[0].version+'"'));
    assert.ok(observed.fingerprint.nativeKernel.coverage.every(surface=>surface.active));
    report.cases.push({preset:'desktop-'+value,first,worker,frame,identity:observed.identity});report.checks.push('Native '+value+' threads / '+value+' GB: first script, worker, frame, HTTP UA/memory/full-version hints and live coverage');
    await attached.disconnect();attached=undefined;await client.stop(id);
    assert.ok((await owner.fingerprintReport(id)).nativeKernel.coverage.every(surface=>!surface.active));
    await client.start(id);attached=await puppeteer.connect({browserWSEndpoint:await client.connectionUrl(id),defaultViewport:null});const restarted=await attached.newPage();await restarted.goto(url);assert.deepEqual(await restarted.evaluate(()=>window.firstIdentity),first);await attached.disconnect();attached=undefined;await client.stop(id);
    const archive=join(root,'profile-'+value+'.tgz');await client.export(id,archive);const imported=await client.importProfile(archive);assert.equal((await client.readProfile(imported.id)).settings.identityPreset,'desktop-'+value);
    report.checks.push('Native '+value+' identity survives graceful restart and Browser archive import');
  }
  const headers={authorization:'Bearer '+config.token,'content-type':'application/json'};
  const response=await fetch(workbenchUrl+'/api/v1/runs',{method:'POST',headers,body:JSON.stringify({automationId:'inspect',preset:'fast',inputs:{url,engine:'vesper',identityPreset:'desktop-4',protection:'standard',webgl:'restricted',audio:'seeded',fonts:'restricted'}})});assert.equal(response.status,202);
  const run=await response.json(),active=await waitRun(run.id,'running');assert.ok(active.profileId);
  assert.equal((await client.readProfile(active.profileId)).settings.identityPreset,'desktop-4');
  attached=await puppeteer.connect({browserWSEndpoint:await client.connectionUrl(active.profileId),defaultViewport:null});
  const activeTarget=await attached.waitForTarget(target=>target.url()===url,{timeout:30000});const activePage=await activeTarget.page();assert.ok(activePage);await activePage.waitForFunction(()=>window.firstIdentity!==undefined);assert.equal((await activePage.evaluate(()=>window.firstIdentity)).memory,4);await attached.disconnect();attached=undefined;
  await runtime.done(run.id);const saved=await waitRun(run.id,'saved');assert.ok(saved.artifact?.sha256);report.checks.push('Workbench Inspect uses the Browser-owned preset and saves a verified archive');
  report.nativeProof=true;report.state='passed';
  await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2));
  if(process.argv.includes('--ui')){
    await writeFile(resolve('.workbench/identity-ui-session.json'),JSON.stringify({root,browserUrl,workbenchUrl,fixtureUrl:url,tokenFile:join(root,'browser/admin-token'),workbenchToken:config.token,output},null,2));
    console.log(JSON.stringify({state:'qualified-awaiting-ui-review',checks:report.checks.length}));
    await new Promise(done=>{process.once('SIGTERM',done);process.once('SIGINT',done);});
  }
} catch(error){report.state='failed';report.errors.push(error.message);await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2));process.exitCode=1;}
finally {await attached?.disconnect();await runtime?.close();await workbench?.close();await client?.close();await owner.close();for(const server of [manager,fixture])await new Promise(done=>server.close(done));console.log(JSON.stringify({state:report.state,checks:report.checks.length,errors:report.errors,output}));}
