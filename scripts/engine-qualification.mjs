import assert from 'node:assert/strict';
import{createServer}from'node:http';
import{readFile,writeFile,mkdir}from'node:fs/promises';
import{join,resolve}from'node:path';
import{createHash,randomUUID}from'node:crypto';
import puppeteer from 'puppeteer-core';
import{VesperBrowser}from'@true-utopian/vesper-browser';

const output=resolve('test-results/expansion'),base=join(output,'engine-'+randomUUID());await mkdir(base,{recursive:true});
const selected=JSON.parse(await readFile(join(output,'native-data/browser/selected-brave.json'),'utf8'));
await writeFile(join(base,'selected-brave.json'),JSON.stringify(selected));
const chrome=JSON.parse(await readFile('.workbench/local-engine/browser.json','utf8'));
const sample=()=>{
 const c=typeof document==='undefined'?new OffscreenCanvas(400,100):document.createElement('canvas');c.width=400;c.height=100;const ctx=c.getContext('2d');
 ctx.fillStyle='#cd4567';ctx.fillRect(3,2,399,80);ctx.font='18px Arial';ctx.fillStyle='#324578';ctx.fillText('Vesper native privacy / true-utopian',11,36);
 return{hardwareConcurrency:navigator.hardwareConcurrency,locale:Intl.DateTimeFormat().resolvedOptions().locale,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,canvas:Array.from(ctx.getImageData(0,0,400,100).data),screen:typeof screen==='undefined'?null:{width:screen.width,height:screen.height},viewport:typeof innerWidth==='undefined'?null:{width:innerWidth,height:innerHeight}};
};
const script=`(${sample.toString()})()`;
const server=createServer((request,response)=>{const pathname=new URL(request.url,'http://fixture.local').pathname;
 if(pathname==='/worker.js'){response.setHeader('content-type','application/javascript');response.end(`postMessage(${script})`);return;}
 response.setHeader('content-type','text/html');response.end(`<!doctype html><title>Vesper native engine fixture</title><h1>Owned local fixture</h1><script>window.first=${script}</script>${pathname==='/main'?`<iframe src="http://localhost:${server.address().port}/frame"></iframe>`:''}`);
});await new Promise(done=>server.listen(0,'127.0.0.1',done));const origin=`http://127.0.0.1:${server.address().port}`;
const owner=new VesperBrowser({directory:base,executablePath:chrome.executablePath,headless:false});
const report={at:new Date().toISOString(),scope:'Headed Windows, owned loopback sites only; no vendor comparison, all-site masking or packet-capture guarantee.',engines:{},checks:[],findings:[]};
const normalize=value=>{const{canvas,...rest}=value;return{...rest,canvasSha256:createHash('sha256').update(Buffer.from(canvas)).digest('hex')};};
try{
 for(const family of ['chromium','brave']){
  const profiles=[];for(let index=0;index<2;index++){
   const{id}=await owner.create({engine:family,name:family+' '+index,locale:'fr-FR',timezone:'America/New_York',environment:{hardwareConcurrency:4,screen:{width:1366,height:768,deviceScaleFactor:1},webRTC:'proxy-only'}});await owner.start(id);
   const connection=await puppeteer.connect({browserWSEndpoint:await owner.connectionUrl(id),defaultViewport:null});
   try{const page=(await connection.pages())[0];await page.goto(origin+'/main');await page.waitForSelector('iframe');const iframe=page.frames().find(f=>f.url().endsWith('/frame'));assert.ok(iframe);
    const main=normalize(await page.evaluate(()=>window.first)),frame=normalize(await iframe.evaluate(()=>window.first));
    const worker=normalize(await page.evaluate(()=>new Promise((done,reject)=>{const w=new Worker('/worker.js');w.onmessage=e=>{done(e.data);w.terminate();};w.onerror=reject;})));
    assert.equal(main.hardwareConcurrency,4);assert.equal(main.timezone,'America/New_York');assert.equal(main.locale,'fr-FR');if(family==='chromium')assert.deepEqual(main.screen,{width:1366,height:768});else report.findings.push('Brave native protection exposes screen '+main.screen.width+'x'+main.screen.height+' for requested 1366x768');assert.equal(frame.hardwareConcurrency,4);assert.equal(frame.timezone,'America/New_York');
    const measured=await owner.environmentReport(id);assert.deepEqual(measured.screen, {...main.screen,colorDepth:24,pixelRatio:1});assert.deepEqual(normalize(await page.evaluate(sample)).viewport,main.viewport);
    await owner.cookies(id,[{name:'vesper-qualification',value:family,domain:'127.0.0.1',path:'/',expires:Math.floor(Date.now()/1000)+86400}]);assert.equal((await owner.cookies(id)).find(c=>c.name==='vesper-qualification').value,family);
    profiles.push({id,main,frame,worker,version:await connection.version()});
   }finally{await connection.disconnect();await owner.stop(id);}
  }
  const archive=join(output,family+'-qualification-'+randomUUID()+'.tgz');await owner.export(profiles[0].id,archive);const imported=await owner.importProfile(archive);await owner.start(imported.id);assert.equal((await owner.cookies(imported.id)).find(c=>c.name==='vesper-qualification').value,family);await owner.stop(imported.id);
  report.engines[family]=profiles;report.checks.push(family+': native launch, first-script parent/frame CPU/timezone, screen, non-mutating inspection, cookie import/read, archive/import/restart');
  report.findings.push(family+': independent-profile canvas samples '+(profiles[0].main.canvasSha256===profiles[1].main.canvasSha256?'equal':'different')+' on this owned loopback fixture; worker CPU/timezone/locale recorded separately');
 }
 await writeFile(join(output,'engine-qualification.json'),JSON.stringify(report,null,2));console.log(report.checks);console.log(report.findings);
}finally{await owner.close();await new Promise(done=>server.close(done));}
