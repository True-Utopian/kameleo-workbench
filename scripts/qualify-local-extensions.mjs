import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import puppeteer from 'puppeteer-core';
import { VesperBrowser, VesperBrowserClient, browserAccessToken, createBrowserServer } from '../packages/vesper-browser/dist/index.js';
import { Runtime } from '../dist/runtime.js';
import { loadConfig } from '../dist/config.js';
import { extensionZip } from './fixtures/extension-package.mjs';

const directory=await mkdtemp(join(tmpdir(),'vesper-extension-proof-'));
const executablePath=JSON.parse(await readFile(resolve('.workbench/local-engine/browser.json'),'utf8')).executablePath;
const browser=new VesperBrowser({directory:join(directory,'browser'),executablePath,headless:true});
const other=new VesperBrowser({directory:join(directory,'imported'),executablePath,headless:true});
const fixture=createServer((_request,response)=>{response.setHeader('content-type','text/html');response.end('<!doctype html><h1>Vesper local extension fixture by true-utopian</h1>');});
await new Promise(done=>fixture.listen(0,'127.0.0.1',done));const url=`http://127.0.0.1:${fixture.address().port}/`;
const report={at:new Date().toISOString(),state:'running',checks:[],observations:[],errors:[],limitations:['Extension boot workers can execute before the CDP policy controller attaches; no native fingerprint claim is made by this extension test.','Packages without their own manifest key receive a stable per-package public identity. Changing such a package creates a new extension identity; automatic storage migration is not implemented.']};
let manager,client,runtime,runId;
async function observe(engine,id){
  const connection=await puppeteer.connect({browserWSEndpoint:await engine.connectionUrl(id),defaultViewport:null});
  try{const page=await connection.newPage();await page.goto(url,{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>document.documentElement.dataset.vesperExtension || document.documentElement.dataset.vesperExtensionError,{timeout:15000});
    const value=await page.evaluate(()=>({result:document.documentElement.dataset.vesperExtension,error:document.documentElement.dataset.vesperExtensionError}));assert.equal(value.error,undefined);
    const result=JSON.parse(value.result);report.observations.push(result);await page.close();return result;
  }finally{await connection.disconnect();}
}
async function waitRun(id,predicate){const deadline=Date.now()+60000;while(Date.now()<deadline){const record=runtime.get(id);if(predicate(record))return record;if(['failed','export_failed','interrupted','cancelled'].includes(record.state))throw new Error(`Extension run ${record.state}: ${record.error}`);await new Promise(done=>setTimeout(done,100));}throw new Error('Extension run timed out');}
try{
  const token=await browserAccessToken(join(directory,'browser'));manager=await createBrowserServer(browser,token);await new Promise(done=>manager.listen(0,'127.0.0.1',done));
  const browserUrl=`http://127.0.0.1:${manager.address().port}`;client=new VesperBrowserClient({url:browserUrl,tokenFile:join(directory,'browser','admin-token')});
  const zip=join(directory,'extension.zip');await writeFile(zip,extensionZip());const extension=await client.importExtension(zip);report.package={id:extension.id,browserId:extension.browserId,version:extension.version};
  const profile=await client.create({name:'Owned extension fixture',extensions:[extension.id]});await client.start(profile.id);
  const pythonCode=`import sys,json\nsys.path.insert(0,sys.argv[1])\nfrom vesper import Browser\nc=Browser(sys.argv[2],sys.argv[3])\np=c.import_extension(sys.argv[4])\nassert any(e['id']==p['id'] for e in c.extensions())\nassert c.profile_extensions(sys.argv[5])[0]['id']==p['id']\nprint(json.dumps({'id':p['id'],'browserId':p['browserId']}))`;
  const python=await promisify(execFile)(process.env.PYTHON??'python',['-c',pythonCode,resolve('sdks/python'),browserUrl,join(directory,'browser','admin-token'),zip,profile.id],{timeout:15000,windowsHide:true});
  assert.deepEqual(JSON.parse(python.stdout),{id:extension.id,browserId:extension.browserId});report.checks.push('Python and TypeScript SDK extension upload/catalog/profile methods agree with the live API');
  const cold=await observe(client,profile.id);assert.equal(cold.visits,1);await client.stop(profile.id);await client.start(profile.id);
  const warm=await observe(client,profile.id);assert.equal(warm.visits,2);await client.stop(profile.id);report.checks.push('Actual Chromium loads the package and persists extension storage after restart');
  const archive=join(directory,'extension-profile.tgz');await client.export(profile.id,archive);const imported=await other.importProfile(archive);assert.equal((await other.extensions()).length,0);await other.start(imported.id);
  const restored=await observe(other,imported.id);assert.equal(restored.visits,3);await other.stop(imported.id);report.checks.push('Archive import preserves the package, browser extension identity and storage without a catalog');
  await client.update(profile.id,{extensions:[]});await client.start(profile.id);const disabled=await puppeteer.connect({browserWSEndpoint:await client.connectionUrl(profile.id),defaultViewport:null});
  try{const page=await disabled.newPage();await page.goto(url);await new Promise(done=>setTimeout(done,750));assert.equal(await page.evaluate(()=>document.documentElement.dataset.vesperExtension),undefined);}finally{await disabled.disconnect();await client.stop(profile.id);}report.checks.push('Unassigning the package disables loading on the next launch');
  const config=await loadConfig({WORKBENCH_TOKEN:'synthetic-extension-proof-access-token',WORKBENCH_DATA_DIR:join(directory,'runs'),EXPORT_DIR:join(directory,'exports'),VESPER_BROWSER_URL:browserUrl,VESPER_BROWSER_TOKEN_FILE:join(directory,'browser','admin-token')});
  runtime=new Runtime({...config,engine:client});await runtime.init();const run=await runtime.submit({automationId:'inspect',inputs:{url,extensions:[extension.id]},preset:'fast'});runId=run.id;
  const running=await waitRun(runId,record=>record.waitingForFinish);await client.claimProfile(running.profileId,runId);const observed=await observe(client,running.profileId);assert.ok(observed.visits>=1);
  const outsider=new VesperBrowserClient({url:browserUrl,tokenFile:join(directory,'browser','admin-token')});await assert.rejects(outsider.update(running.profileId,{extensions:[]}),error=>error.status===409);
  await runtime.done(runId);const saved=await waitRun(runId,record=>record.state==='saved');const bytes=await readFile(saved.artifact.path);assert.equal(createHash('sha256').update(bytes).digest('hex'),saved.artifact.sha256);
  report.run={state:saved.state,archiveBytes:bytes.length,sha256:saved.artifact.sha256};assert.deepEqual((await client.profileExtensions(saved.profileId)).map(item=>item.id),[extension.id]);
  assert.ok((await client.listProfiles()).every(profile=>profile.state==='stopped'&&!profile.lease));report.checks.push('Workbench Inspect assigns the extension through the Browser API, prevents lease hijacking and saves a verified archive');report.state='passed';
}catch(error){report.state='failed';report.errors.push(error.stack??String(error));process.exitCode=1;}
finally{
  if(runId&&runtime&&!['saved','cancelled'].includes(runtime.get(runId).state))await runtime.cancel(runId).catch(()=>{});
  await runtime?.close();await client?.close();if(manager)await new Promise(done=>manager.close(done));await other.close();await browser.close();await new Promise(done=>fixture.close(done));
  const output=resolve('test-results/extensions');await mkdir(output,{recursive:true});await writeFile(join(output,'local-pair-qualification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
  assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true});
}
