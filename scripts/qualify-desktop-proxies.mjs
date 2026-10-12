import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { VesperBrowserClient } from '../packages/vesper-browser/dist/index.js';

// Connect to real packaged or installed services. Never starts substitute source services.
const index=process.argv.indexOf('--data-root');
assert.ok(index>=0 && process.argv[index+1], 'Supply the running desktop data root');
const directory=resolve(process.argv[index+1]), packaged=process.argv.includes('--packaged');
const stage=packaged?'packaged':'installed', output=resolve('test-results/proxy-inventory');
await mkdir(output,{recursive:true});
const report={at:new Date().toISOString(),state:'running',scope:`${stage} desktop Browser and signed Workbench add-on`,checks:[],errors:[],nativeProof:false,actualInstalledProof:false};
const nonce=randomBytes(16).toString('hex'),username='owned-desktop-fixture',password=randomBytes(24).toString('base64url');
const expectedAuth='Basic '+Buffer.from(username+':'+password).toString('base64');
let proxyHits=0, connection, runId, savedProxy, client, workbench, baseline, catalogBaseline;
const ownedProfiles=new Set();
const proxy=createServer((request,response)=>{
  if(request.headers['proxy-authorization']!==expectedAuth){response.writeHead(407,{'proxy-authenticate':'Basic realm="Owned fixture"'});response.end();return;}
  if(request.url!==`http://vesper-owned.invalid:18444/fixture?nonce=${nonce}`){response.writeHead(403);response.end();return;}
  proxyHits++;response.writeHead(200,{'content-type':'text/html'});
  response.end(`<title>Owned desktop proxy fixture</title><script>window.proxyFixture=${JSON.stringify(nonce)}</script><p>Authenticated routing passed.</p>`);
});
proxy.on('connect',(_request,socket)=>socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'));
async function service(kind){
  const descriptor=JSON.parse(await readFile(join(directory,kind,'service.json'),'utf8'));
  assert.ok(Number.isInteger(descriptor.port)&&descriptor.port>0&&descriptor.port<65536);
  const token=(await readFile(join(directory,kind,'admin-token'),'utf8')).trim(),url=`http://127.0.0.1:${descriptor.port}`;
  return {url,async api(path,method='GET',data){
    const response=await fetch(url+'/api/v1'+path,{method,redirect:'error',signal:AbortSignal.timeout(30000),headers:{authorization:'Bearer '+token,...(data?{'content-type':'application/json'}:{})},...(data?{body:JSON.stringify(data)}:{})});
    assert.ok(response.ok,`${kind} qualification API returned ${response.status}`);
    return response.headers.get('content-type')?.includes('json')?response.json():Buffer.from(await response.arrayBuffer());
  }};
}
async function waitRun(state){
  const deadline=Date.now()+90000;
  while(Date.now()<deadline){
    const current=await workbench.api('/runs/'+runId);
    if(current.state===state)return current;
    assert.ok(!['failed','cancelled','interrupted','export_failed'].includes(current.state),'Owned desktop run entered '+current.state);
    await new Promise(done=>setTimeout(done,200));
  }
  throw new Error('Owned desktop run timed out waiting for '+state);
}
try{
  const browser=await service('browser');workbench=await service('workbench');
  report.versions={browser:(await browser.api('/capabilities')).version,workbench:(await workbench.api('/capabilities')).version};
  const expected={browser:JSON.parse(await readFile('packages/vesper-browser/package.json','utf8')).version,workbench:JSON.parse(await readFile('package.json','utf8')).version};
  assert.deepEqual(report.versions,expected,'Desktop must run the release being qualified');
  client=new VesperBrowserClient({url:browser.url,tokenFile:join(directory,'browser/admin-token')});
  baseline=await client.listProfiles();catalogBaseline=await client.proxies();
  assert.ok(baseline.every(profile=>profile.state!=='running'&&!profile.lease),'Require idle profiles');
  const existingRuns=await workbench.api('/runs');
  assert.ok(existingRuns.every(run=>['saved','failed','cancelled','interrupted','export_failed'].includes(run.state)),'Require idle Workbench');
  await new Promise(done=>proxy.listen(0,'127.0.0.1',done));
  savedProxy=await client.saveProxy({name:'Owned desktop relay '+nonce.slice(0,8),connection:{value:'http',extra:{host:'127.0.0.1',port:proxy.address().port,id:username,secret:password}}});
  assert.equal(savedProxy.hasPassword,true);assert.equal(savedProxy.hasUsername,true);
  assert.ok(!JSON.stringify(await client.proxies()).includes(password));
  report.checks.push('Packaged service creates reusable connections without reading credentials back');
  const edited=await client.saveProxy({name:'Owned edited relay '+nonce.slice(0,8),revision:savedProxy.revision},savedProxy.id);
  await assert.rejects(client.saveProxy({name:'Stale edit',revision:savedProxy.revision},savedProxy.id),{status:412});
  await assert.rejects(client.create({name:'Owned stale reference',savedProxy:{id:savedProxy.id,revision:savedProxy.revision}}),{status:412});
  savedProxy=edited;assert.equal(savedProxy.hasPassword,true);
  report.checks.push('Credential-preserving edits and stale edit/profile-creation revision rejection work in the desktop service');
  const run=await workbench.api('/runs','POST',{automationId:'inspect',inputs:{url:`http://vesper-owned.invalid:18444/fixture?nonce=${nonce}`,savedProxyId:savedProxy.id,savedProxyRevision:savedProxy.revision},preset:'fast'});
  runId=run.id;const running=await waitRun('running');ownedProfiles.add(running.profileId);
  await client.claimProfile(running.profileId,runId);
  connection=await puppeteer.connect({browserWSEndpoint:await client.connectionUrl(running.profileId),defaultViewport:null});
  const target=await connection.waitForTarget(target=>target.type()==='page'&&target.url().includes(nonce),{timeout:20000});
  const page=await target.page();await page.waitForFunction(()=>typeof window.proxyFixture==='string',{timeout:20000});
  assert.equal(await page.evaluate(()=>window.proxyFixture),nonce);assert.ok(proxyHits>0);
  report.checks.push('Signed Workbench add-on starts a leased profile through the saved authenticated proxy and real bundled Chromium reaches the owned origin');
  await assert.rejects(client.assignProxy(running.profileId,savedProxy.id,savedProxy.revision),{status:409});
  report.checks.push('Running profile connection replacement is blocked');
  await connection.disconnect();connection=undefined;
  await workbench.api('/runs/'+runId+'/finish','POST',{});const completed=await waitRun('saved');
  const archive=await workbench.api('/runs/'+runId+'/artifact');
  assert.equal(createHash('sha256').update(archive).digest('hex'),completed.artifact.sha256);
  const privateDirectory=resolve('.workbench/desktop-proxy-proof',stage+'-'+nonce.slice(0,8));await mkdir(privateDirectory,{recursive:true});
  const archivePath=join(privateDirectory,'owned-profile.tgz');await writeFile(archivePath,archive);
  const imported=await client.importProfile(archivePath);ownedProfiles.add(imported.id);
  assert.equal((await client.readProfile(imported.id)).hasProxy,false);
  report.checks.push('Workbench saves a checksum-verified archive and importing it excludes proxy credentials');
  const python=process.env.PYTHON_EXECUTABLE||(process.platform==='win32'?'C:/Python314/python.exe':'python3');
  const pythonCode='import sys\nsys.path.insert(0,"sdks/python")\nfrom vesper import Browser\nb=Browser(sys.argv[1],token_file=sys.argv[2])\np=next(p for p in b.proxies() if p["id"]==sys.argv[3])\nassert p["hasPassword"] and "secret" not in p\nb.assign_proxy(sys.argv[4],p["id"],p["revision"])\np=b.save_proxy({"name":"Owned Python desktop edit","revision":p["revision"]},p["id"])\nb.remove_proxy(p["id"],p["revision"])\nassert all(p["id"]!=sys.argv[3] for p in b.proxies())\n';
  await new Promise((done,reject)=>{
    const child=spawn(python,['-c',pythonCode,browser.url,join(directory,'browser/admin-token'),savedProxy.id,imported.id],{windowsHide:true,stdio:['ignore','ignore','pipe']});
    let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);child.on('error',reject);child.on('exit',code=>code===0?done():reject(new Error('Python desktop proxy SDK failed: '+stderr)));
  });savedProxy=undefined;
  assert.equal((await client.readProfile(running.profileId)).hasProxy,true);
  assert.equal((await client.readProfile(imported.id)).hasProxy,true);
  assert.deepEqual(await client.proxies(),catalogBaseline);
  report.checks.push('Python SDK assigns, edits and removes only the owned connection; independent profile copies persist and the original catalog is unchanged');
  report.run={id:runId,state:completed.state,archiveBytes:archive.length,sha256:completed.artifact.sha256};report.proxyRequests=proxyHits;
  report.state='passed';
}catch(error){report.state='failed';report.errors.push(error.message);}
finally{
  try{
    await connection?.disconnect();
    if(runId){const run=await workbench.api('/runs/'+runId);if(!['saved','failed','cancelled','interrupted','export_failed'].includes(run.state))await workbench.api('/runs/'+runId+'/cancel','POST',{});}
    if(savedProxy){const current=(await client.proxies()).find(proxy=>proxy.id===savedProxy.id);if(current)await client.removeProxy(current.id,current.revision);}
    for(const id of ownedProfiles){await client.releaseProfile(id);await client.trash(id);}
    if(baseline){const after=(await client.listProfiles()).filter(profile=>!ownedProfiles.has(profile.id));assert.deepEqual(after,baseline);assert.deepEqual(await client.proxies(),catalogBaseline);report.checks.push('Original profile manifests and connections are unchanged; only owned fixture profiles are moved to trash');}
  }catch(error){report.state='failed';report.errors.push('Cleanup/preservation: '+error.message);}
  proxy.closeAllConnections();await new Promise(done=>proxy.close(()=>done()));
  report.actualInstalledProof=!packaged&&report.state==='passed';
  await writeFile(join(output,stage+'-pair.json'),JSON.stringify(report,null,2));
}
console.log(JSON.stringify(report,null,2));
if(report.state!=='passed')process.exitCode=1;
