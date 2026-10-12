import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';
import { observeFingerprintSurfaces, assessFingerprintConsistency } from './lib/fingerprint-observation.mjs';
const args=process.argv.slice(2);
assert.equal(args.length,2,'Usage: node scripts/fingerprint-surface-audit.mjs --executable <owned browser executable>');assert.equal(args[0],'--executable');
const executable=await realpath(resolve(args[1])),temporary=await realpath(await mkdtemp(join(tmpdir(),'vesper-surface-audit-')));
const hash=createHash('sha256');for await(const bytes of createReadStream(executable))hash.update(bytes);
const sample=`(${observeFingerprintSurfaces.toString()})()`,requests=[],contexts={};
let browser,origin,port;
const server=createServer((request,response)=>{
  requests.push({path:new URL(request.url,'http://owned.invalid').pathname,userAgent:request.headers['user-agent']??null,platform:request.headers['sec-ch-ua-platform']??null,brands:request.headers['sec-ch-ua']??null});
  response.setHeader('cache-control','no-store');response.setHeader('accept-ch','Sec-CH-UA-Platform, Sec-CH-UA, Sec-CH-UA-Full-Version-List, Sec-CH-UA-Platform-Version');
  const path=new URL(request.url,'http://owned.invalid').pathname;
  if(path==='/worker.js'){response.setHeader('content-type','application/javascript');response.end(`${sample}.then(value=>postMessage(value));`);}
  else if(path==='/shared.js'){response.setHeader('content-type','application/javascript');response.end(`const first=${sample};onconnect=e=>{e.ports[0].start();first.then(value=>e.ports[0].postMessage(value));};`);}
  else if(path==='/service.js'){response.setHeader('content-type','application/javascript');response.end(`const first=${sample};addEventListener('install',()=>skipWaiting());addEventListener('activate',e=>e.waitUntil(clients.claim()));addEventListener('message',e=>e.waitUntil(first.then(value=>e.ports[0].postMessage(value))));`);}
  else {response.setHeader('content-type','text/html');response.end(`<!doctype html><title>Owned Vesper surface audit</title><script>window.first=${sample}</script>${path==='/main'?`<iframe src="/frame"></iframe><iframe src="http://localhost:${port}/cross-frame"></iframe>`:''}`);}
});
const report={schemaVersion:1,author:'true-utopian',at:new Date().toISOString(),state:'running',executableSha256:hash.digest('hex'),nativeProof:false,scope:'Original owned loopback fixture and disposable browser store; no identity overrides or vendor/private profiles',contexts,requests,errors:[],limitations:['Observed consistency does not prove fingerprint masking, detection avoidance or vendor parity.','Unavailable and permission-dependent APIs are recorded without asking for permissions.','This headless audit does not qualify headed display behavior or network leaks.']};
try {
  await new Promise(done=>server.listen(0,'127.0.0.1',done));port=server.address().port;origin=`http://127.0.0.1:${port}`;
  browser=await puppeteer.launch({executablePath:executable,headless:true,userDataDir:temporary,args:['--disable-background-networking','--disable-component-update','--no-first-run','--no-default-browser-check'],timeout:30000});
  const page=(await browser.pages())[0];await page.goto(`${origin}/main`,{waitUntil:'load',timeout:15000});contexts.main=await page.evaluate(()=>window.first);
  for(const name of ['frame','cross-frame']){const frame=page.frames().find(frame=>new URL(frame.url()).pathname===`/${name}`);assert.ok(frame);contexts[name]=await frame.evaluate(()=>window.first);}
  contexts.dedicated=await page.evaluate(()=>new Promise((done,reject)=>{const worker=new Worker('/worker.js'),timer=setTimeout(()=>{worker.terminate();reject(Error('Worker timeout'));},15000);worker.onmessage=e=>{clearTimeout(timer);worker.terminate();done(e.data);};worker.onerror=e=>{clearTimeout(timer);worker.terminate();reject(Error(e.message));};}));
  contexts.shared=await page.evaluate(()=>new Promise((done,reject)=>{const worker=new SharedWorker('/shared.js'),timer=setTimeout(()=>{worker.port.close();reject(Error('Shared worker timeout'));},15000);worker.port.onmessage=e=>{clearTimeout(timer);worker.port.close();done(e.data);};worker.onerror=e=>{clearTimeout(timer);worker.port.close();reject(Error(e.message));};worker.port.start();}));
  contexts.service=await page.evaluate(async()=>{const registration=await navigator.serviceWorker.register('/service.js');await navigator.serviceWorker.ready;return new Promise((done,reject)=>{const channel=new MessageChannel(),timer=setTimeout(()=>{channel.port1.close();reject(Error('Service worker timeout'));},15000);channel.port1.onmessage=e=>{clearTimeout(timer);channel.port1.close();done(e.data);};registration.active.postMessage('owned-probe',[channel.port2]);});});
  await page.reload({waitUntil:'load'});contexts.reload=await page.evaluate(()=>window.first);
  await browser.close();browser=undefined;
  browser=await puppeteer.launch({executablePath:executable,headless:true,userDataDir:temporary,args:['--disable-background-networking','--disable-component-update','--no-first-run','--no-default-browser-check'],timeout:30000});
  const restarted=(await browser.pages())[0];await restarted.goto(`${origin}/restart`,{waitUntil:'load'});contexts.restart=await restarted.evaluate(()=>window.first);
  Object.assign(report,assessFingerprintConsistency(contexts,requests));report.state='observed';report.completedAt=new Date().toISOString();
}catch(error){report.state='failed';report.errors.push(error.message);process.exitCode=1;}
finally {await browser?.close();await new Promise(done=>server.close(done));const inside=relative(await realpath(tmpdir()),temporary);assert.ok(inside&&!inside.startsWith('..')&&inside.startsWith('vesper-surface-audit-'));await rm(temporary,{recursive:true,force:true,maxRetries:5,retryDelay:100});const output=resolve('test-results/fingerprint-surfaces');await mkdir(output,{recursive:true});await writeFile(join(output,'observations.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({state:report.state,contexts:Object.keys(contexts),mismatches:report.mismatches?.length??null,errors:report.errors,nativeProof:false}));}
