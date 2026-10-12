import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { VesperBrowser, VesperBrowserClient, browserAccessToken, createBrowserServer } from '../packages/vesper-browser/dist/index.js';
import { Runtime } from '../dist/runtime.js';
import { createServer } from '../dist/server.js';
import { loadConfig } from '../dist/config.js';

// Only synthetic temporary profiles, a loopback proxy and an origin owned by this fixture.
const directory = await mkdtemp(join(tmpdir(),'vesper-proxy-inventory-'));
const output = resolve('test-results/proxy-inventory'); await mkdir(output,{recursive:true});
const executablePath = process.env.LOCAL_BROWSER_EXECUTABLE || JSON.parse(await readFile('.workbench/local-engine/browser.json','utf8')).executablePath;
const engine = new VesperBrowser({directory:join(directory,'browser'),executablePath,headless:true});
const nonce=randomBytes(16).toString('hex'),username='owned-proxy-user',password=randomBytes(24).toString('base64url');
const expectedAuth='Basic '+Buffer.from(username+':'+password).toString('base64');
let proxyHits=0,manager,client,runtime,workbench,connection,runId,retainedForUi=false;
const proxy=httpServer((request,response)=>{
  if(request.headers['proxy-authorization']!==expectedAuth){response.writeHead(407,{'proxy-authenticate':'Basic realm="Owned fixture"'});response.end();return;}
  if(request.url!==`http://vesper-owned.invalid:18444/fixture?nonce=${nonce}`){response.writeHead(403);response.end();return;}
  proxyHits++; response.writeHead(200,{'content-type':'text/html'});response.end(`<title>Owned proxy fixture</title><script>window.proxyFixture=${JSON.stringify(nonce)}</script><p>Owned proxy routing passed.</p>`);
});
proxy.on('connect',(_request,socket)=>socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'));
const report={at:new Date().toISOString(),state:'running',scope:'Source Browser and Workbench, isolated temporary data; installed desktop unchanged',checks:[],errors:[],nativeProof:false};
async function cleanup(){
  await connection?.disconnect().catch(()=>{});
  if(runId && runtime?.get(runId)?.state!=='saved')await runtime?.cancel(runId).catch(()=>{});
  await workbench?.close();await runtime?.close();await client?.close();
  if(manager)await new Promise(done=>manager.close(()=>done()));
  await engine.close();proxy.closeAllConnections();await new Promise(done=>proxy.close(()=>done()));
  const target=resolve(directory),temp=resolve(tmpdir());assert.ok(target.startsWith(temp+sep));await rm(target,{recursive:true,force:true});
}
try{
  await new Promise(done=>proxy.listen(0,'127.0.0.1',done));
  const token=await browserAccessToken(join(directory,'browser')); manager=await createBrowserServer(engine,token);await new Promise(done=>manager.listen(0,'127.0.0.1',done));
  const browserUrl='http://127.0.0.1:'+manager.address().port;
  client=new VesperBrowserClient({url:browserUrl,tokenFile:join(directory,'browser/admin-token')});
  const saved=await client.saveProxy({name:'Owned authenticated relay',connection:{value:'http',extra:{host:'127.0.0.1',port:proxy.address().port,id:username,secret:password}}});
  assert.equal(saved.hasPassword,true);assert.ok(!JSON.stringify(await client.proxies()).includes(password));
  report.checks.push('Browser API keeps the reusable proxy encrypted and returns credential-presence flags');
  const config=await loadConfig({BROWSER_BACKEND:'local',VESPER_BROWSER_URL:browserUrl,VESPER_BROWSER_TOKEN_FILE:join(directory,'browser/admin-token'),WORKBENCH_DATA_DIR:join(directory,'workbench'),EXPORT_DIR:join(directory,'exports'),WORKBENCH_TOKEN:'synthetic-proxy-inventory-workbench-token',RUN_TIMEOUT_MS:'120000'});
  runtime=new Runtime({...config,engine:client});await runtime.init();workbench=await createServer(config,runtime,{publicInventory:()=>[]},client);
  const workbenchUrl=await workbench.listen({host:'127.0.0.1',port:0});
  const api=async(path,method='GET',data)=>{const response=await fetch(workbenchUrl+'/api/v1'+path,{method,signal:AbortSignal.timeout(30000),headers:{authorization:'Bearer '+config.token,...(data?{'content-type':'application/json'}:{})},...(data?{body:JSON.stringify(data)}:{})});assert.ok(response.ok,`Workbench ${response.status}: ${response.ok?'':await response.text()}`);return response.json();};
  const run=await api('/runs','POST',{automationId:'inspect',inputs:{url:`http://vesper-owned.invalid:18444/fixture?nonce=${nonce}`,savedProxyId:saved.id,savedProxyRevision:1},preset:'fast'});runId=run.id;
  async function wait(state){const deadline=Date.now()+60000;while(Date.now()<deadline){const current=runtime.get(runId);if(current.state===state)return current;assert.ok(!['failed','cancelled','interrupted','export_failed'].includes(current.state),JSON.stringify(current));await new Promise(done=>setTimeout(done,100));}throw new Error('Workbench timed out waiting for '+state);}
  const running=await wait('running');await client.claimProfile(running.profileId,runId);
  connection=await puppeteer.connect({browserWSEndpoint:await client.connectionUrl(running.profileId),defaultViewport:null});
  const target=await connection.waitForTarget(target=>target.type()==='page'&&target.url().includes(nonce),{timeout:20000});const page=await target.page();await page.waitForFunction(()=>typeof window.proxyFixture==='string',{timeout:20000});
  assert.equal(await page.evaluate(()=>window.proxyFixture),nonce);assert.ok(proxyHits>0);
  report.checks.push('Workbench creates a leased Browser profile from the saved proxy reference before launch; real Chromium reaches the owned origin through authenticated routing');
  await assert.rejects(client.assignProxy(running.profileId,saved.id,1),{status:409});
  report.checks.push('Running-profile proxy replacement is refused');
  await connection.disconnect();connection=undefined;await api('/runs/'+runId+'/finish','POST',{});const completed=await wait('saved');
  const archive=await readFile(completed.artifact.path);assert.equal(createHash('sha256').update(archive).digest('hex'),completed.artifact.sha256);
  const imported=await client.importProfile(completed.artifact.path);assert.equal((await client.readProfile(imported.id)).hasProxy,false);
  assert.equal((await client.readProfile(running.profileId)).hasProxy,true);
  report.checks.push('Workbench saves a checksum-verified archive, releases ownership and imports an independent profile without proxy credentials');
  const python=process.env.PYTHON_EXECUTABLE || (process.platform==='win32'?'C:/Python314/python.exe':'python3');
  const pythonCode='import sys\nsys.path.insert(0,"sdks/python")\nfrom vesper import Browser\nb=Browser(sys.argv[1],token_file=sys.argv[2])\np=b.proxies()[0]\nassert p["hasPassword"] and "secret" not in p\nx=b.create({"name":"Owned Python fixture"})\nb.assign_proxy(x["id"],p["id"],p["revision"])\np=b.save_proxy({"name":"Owned Python edited","revision":p["revision"]},p["id"])\nassert p["revision"]==2\nb.remove_proxy(p["id"],2)\nassert b.proxies()==[]\n';
  await new Promise((done,reject)=>{const child=spawn(python,['-c',pythonCode,browserUrl,join(directory,'browser/admin-token')],{windowsHide:true,stdio:['ignore','ignore','pipe']});let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);child.on('error',reject);child.on('exit',code=>code===0?done():reject(new Error('Python proxy SDK failed: '+stderr)));});
  assert.equal((await client.readProfile(running.profileId)).hasProxy,true);
  report.checks.push('Python SDK lists, assigns, edits and removes saved proxies; existing profile copies remain intact');
  report.run={id:runId,state:completed.state,archiveBytes:archive.length,sha256:completed.artifact.sha256};report.proxyRequests=proxyHits;report.state='passed';
  await writeFile(join(output,'pair.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
  if(process.argv.includes('--ui')){
    const stateFile=resolve('.workbench/proxy-inventory-ui.json');await writeFile(stateFile,JSON.stringify({directory,browserUrl,workbenchUrl,browserToken:token,workbenchToken:config.token}));
    retainedForUi=true;console.log('Owned source UI fixtures ready. Installed desktop unchanged.');
    process.once('SIGINT',()=>{void cleanup().then(()=>process.exit(0)).catch(error=>{console.error(error);process.exit(1);});});
  }
}catch(error){report.state='failed';report.errors.push(error.message);await writeFile(join(output,'pair.json'),JSON.stringify(report,null,2));throw error;}
finally{if(!retainedForUi)await cleanup();}
