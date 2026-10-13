import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,realpath,stat} from 'node:fs/promises';
import {join,resolve,relative,dirname} from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:net';
import * as tar from 'tar';
import {_electron} from 'playwright';
import puppeteer from 'puppeteer-core';
import {VesperBrowserClient} from '../packages/vesper-browser/dist/client.js';
import {nativeExecutableHash,verifyNativeRuntime} from '../packages/vesper-browser/dist/native-kernel.js';
import update from '../desktop/update-contract.cjs';
import plugin from '../desktop/plugin-contract.cjs';

assert.equal(process.platform,'linux');assert.ok(process.getuid()!==0,'Use the isolated non-root qualification account');
const arg=name=>{const i=process.argv.indexOf(name);assert.ok(i>=0&&process.argv[i+1],name+' required');return resolve(process.argv[i+1]);};
const parent=await realpath(arg('--workspace'));const qa=await mkdtemp(join(parent,'owned-linux-install-')),data=join(qa,'data'),prefix=join(qa,'installed');await mkdir(data);
const output=resolve('test-results/desktop/linux-runtime-qualification.json'),json=async path=>JSON.parse(await readFile(path,'utf8'));
const versions={browser:(await json('packages/vesper-browser/package.json')).version,workbench:(await json('package.json')).version};
const graphicsBackend=process.argv.includes('--software-graphics')?'software':'default';
const report={at:new Date().toISOString(),state:'running',platform:'linux',versions,graphicsBackend,installationMethod:'Versioned per-user portable installer',installerExecuted:false,sandboxVerified:false,nativeKernelQualified:false,visualReviewPassed:false,checks:[],errors:[],qaRoot:qa};
let app,browserApi,workbenchApi,connection,sandboxProfileId,client;
const pause=ms=>new Promise(done=>setTimeout(done,ms));
async function service(kind){
 const deadline=Date.now()+120000;let lastError;
 while(Date.now()<deadline){
  try{
   const descriptor=await json(join(data,kind,'service.json'));const token=(await readFile(join(data,kind,'admin-token'),'utf8')).trim(),url=`http://127.0.0.1:${descriptor.port}`;
   const ready=await fetch(url+'/api/v1/capabilities',{headers:{authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(3000)});
   assert.ok(ready.ok,kind+' readiness HTTP '+ready.status);assert.equal((await ready.json()).version,versions[kind]);
   return {url,api:async(path,method='GET',body)=>{const r=await fetch(url+'/api/v1'+path,{method,redirect:'error',headers:{authorization:'Bearer '+token,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(240000)});assert.ok(r.ok,kind+' HTTP '+r.status);return r.headers.get('content-type')?.includes('json')?r.json():Buffer.from(await r.arrayBuffer());}};
  }catch(error){lastError=error;await pause(250);}
 }
 throw new Error(kind+' did not become ready within 120 seconds',{cause:lastError});
}
async function command(args,name){const child=spawn(process.execPath,args,{stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',chunk=>log+=chunk);child.stderr.on('data',chunk=>log+=chunk);const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',done);});await writeFile(join(qa,name+'.log'),log);assert.equal(code,0,name+' failed; inspect the retained owned log');}
async function quit(){if(!app)return;const owner=app;const closed=owner.waitForEvent('close',{timeout:120000});await owner.evaluate(({Menu})=>{const item=Menu.getApplicationMenu().items[0].submenu.items.find(value=>value.label==='Quit');if(!item)throw Error('Missing normal Quit action');item.click();});await closed;app=undefined;}
async function launch(executable,debugPort){const env={...process.env,VESPER_DESKTOP_DATA_DIR:data,VESPER_BROWSER_HEADLESS:'false',VESPER_GRAPHICS_BACKEND:graphicsBackend};for(const name of ['ELECTRON_RUN_AS_NODE','VESPER_BROWSER_EXECUTABLE','VESPER_BUNDLED_KERNEL_MANIFEST'])delete env[name];app=await _electron.launch({executablePath:executable,env,args:['--remote-debugging-port='+debugPort,'--remote-debugging-address=127.0.0.1'],timeout:120000});const page=await app.firstWindow();page.on('pageerror',error=>report.errors.push(error.message));await page.waitForSelector('#workspace:not([hidden])',{timeout:120000});return page;}
try{
 for(const [product,version] of Object.entries(versions)){
  const archive=await realpath(resolve(`release/${product}/linux/Vesper-${product}-${version}-linux-x64.tar.gz`));const child=relative(await realpath(resolve('release')),archive);assert.ok(child&&!child.startsWith('..'));
  const expected=(await readFile(resolve(`release/${product}/linux/SHA256SUMS`),'utf8')).split(/\r?\n/).find(line=>line.slice(66)===`Vesper-${product}-${version}-linux-x64.tar.gz`);assert.ok(expected);assert.equal(await nativeExecutableHash(archive),expected.slice(0,64));
  const source=join(qa,'extracted-'+product);await mkdir(source);await tar.x({file:archive,cwd:source,strict:true,preservePaths:false});
  await promisify(execFile)('sh',[join(source,'install.sh'),'--prefix',prefix,'--no-launcher'],{timeout:120000});
  const executable=join(prefix,product,version,`vesper-${product}`);assert.ok((await stat(executable)).mode&0o111);
  const manifest=await json(join(prefix,product,version,'resources/vesper-kernel/vesper-kernel.json'));assert.equal(manifest.qualification.state,'passed');assert.equal(manifest.qualification.nativeProof,true);await verifyNativeRuntime(join(prefix,product,version,'resources/vesper-kernel/chrome'),manifest.runtimeFiles);
 }
 report.installerExecuted=true;report.checks.push('Both checksum-matching release tar archives extract with executable launchers; their real portable installers execute into new version directories and retain native component hashes');
 const reserve=createServer();await new Promise(done=>reserve.listen(0,'127.0.0.1',done));const debugPort=reserve.address().port;await new Promise(done=>reserve.close(done));
 const executable=join(prefix,'browser',versions.browser,'vesper-browser'),manifestPath=join(prefix,'browser',versions.browser,'resources/vesper-kernel/vesper-kernel.json');let page=await launch(executable,debugPort);browserApi=await service('browser');assert.equal((await browserApi.api('/capabilities')).version,versions.browser);
 const key=await readFile('desktop/update-public-key.pem','utf8');for(const [product,version] of Object.entries(versions))await update.verifyLocalUpdate(resolve(`release/${product}/linux/vesper-${product}_${version}_amd64.deb.vesper-update.json`),key,{product,platform:'linux',arch:'x64',version:'0.0.0'});
 const addon=resolve(`release/addons/Vesper-workbench-${versions.workbench}.vplugin.tgz.vesper-plugin.json`);await plugin.verifyPlugin(addon,key,{platform:'linux',arch:'x64'});
 // Fixture-only native picker staging in this newly owned store. UI signoff is separate.
 await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});dialog.showMessageBox=async()=>({response:0});},addon);
 assert.equal((await page.evaluate(()=>window.vesperDesktop.installWorkbench())).version,versions.workbench);await page.evaluate(()=>window.vesperDesktop.setWorkbenchEnabled(true));workbenchApi=await service('workbench');assert.equal((await workbenchApi.api('/capabilities')).version,versions.workbench);report.checks.push('Installed Browser verifies the local release signatures, installs the signed add-on and starts matching Workbench services');
 const preserved=await browserApi.api('/profiles','POST',{name:'Owned Linux preservation fixture',notes:'Preserve across activation and restart',favorite:true}),before=(await browserApi.api('/profiles')).find(value=>value.id===preserved.id);
 await command(['scripts/activate-native-kernel.mjs','--manifest',manifestPath,'--data-root',data,'--activate'],'installed-native-integration');const native=await json('test-results/native-kernel/installed-native-integration.json');assert.equal(native.state,'passed');assert.equal(native.actualInstalledProof,true);assert.equal(native.installedKernelChanged,true);assert.equal(native.activation.profilesBackedUp,1);assert.deepEqual(native.errors,[]);report.nativeKernelQualified=true;report.nativeChecks=native.checks;report.executableSha256=native.executableSha256;report.run=native.run;
 const after=(await browserApi.api('/profiles')).find(value=>value.id===preserved.id);assert.deepEqual(after.settings,before.settings);assert.equal(after.notes,before.notes);
 client=new VesperBrowserClient({url:browserApi.url,tokenFile:join(data,'browser/admin-token')});const owned=await client.create({name:'Owned sandbox qualification',engine:'vesper'});sandboxProfileId=owned.id;await client.start(owned.id);connection=await puppeteer.connect({browserWSEndpoint:await client.connectionUrl(owned.id),defaultViewport:null});const tab=await connection.newPage();await tab.goto('chrome://sandbox',{waitUntil:'domcontentloaded'});const text=await tab.evaluate(()=>document.body.innerText);
 assert.match(text,/PID namespaces\s+Yes/i);assert.match(text,/Network namespaces\s+Yes/i);assert.match(text,/Seccomp-BPF sandbox\s+Yes/i);report.sandboxStatus=text;report.sandboxVerified=true;await tab.close();await connection.disconnect();connection=undefined;await client.stop(owned.id);await client.trash(owned.id);sandboxProfileId=undefined;report.checks.push('Installed native Chromium reports active PID/network namespaces and seccomp-BPF sandboxing');
 await command(['scripts/qualify-installed-pair.mjs','--extended','--catalog-removal','--data-root',data],'installed-api-pair');const apis=await json('test-results/native-engine/installed-pair-qualification.json');assert.equal(apis.state,'passed');assert.deepEqual(apis.versions,versions);report.apiChecks=apis.checks;
 await command(['scripts/qualify-desktop-proxies.mjs','--data-root',data],'installed-proxies');const proxies=await json('test-results/proxy-inventory/installed-pair.json');assert.equal(proxies.state,'passed');assert.deepEqual(proxies.versions,versions);report.proxyChecks=proxies.checks;
 await quit();page=await launch(executable,debugPort);browserApi=await service('browser');workbenchApi=await service('workbench');assert.equal((await workbenchApi.api('/capabilities')).version,versions.workbench);assert.equal((await workbenchApi.api('/runs/'+native.run.id)).state,'saved');assert.deepEqual((await browserApi.api('/profiles')).find(value=>value.id===preserved.id).settings,before.settings);report.checks.push('Normal Quit and restart preserve the signed add-on, original owned profile and saved Browser–Workbench run');
 // Keep the actual installed window available for persistent remote CDP UI review.
 const debugInfo=await fetch(`http://127.0.0.1:${debugPort}/json/version`,{signal:AbortSignal.timeout(3000)});assert.ok(debugInfo.ok,'Installed Electron inspection endpoint must be available for the separate UI review');
 const ready={at:new Date().toISOString(),state:'awaiting-ui-review',qaRoot:qa,dataRoot:data,debugPort,versions,runId:native.run.id,marker:join(qa,'ui-reviewed.json')};await writeFile(join(parent,'linux-ui-ready.json'),JSON.stringify(ready,null,2));report.state='awaiting-ui-review';await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2));
 const deadline=Date.now()+2*60*60*1000;let reviewed,lastUiRequest;
 while(Date.now()<deadline){
  // Fixed operations on this helper's own Electron window only, for remote visual review.
  try{
   const request=await json(join(qa,'ui-request.json'));assert.ok(['launch','small'].includes(request.id));
   if(request.id!==lastUiRequest){
    const receipt=await app.evaluate(async({BrowserWindow},id)=>{const win=BrowserWindow.getAllWindows()[0];if(id==='small')win.setSize(1000,720);await new Promise(done=>setTimeout(done,400));const [width,height]=win.getContentSize();const bytes=(await win.capturePage()).resize({width,height,quality:'best'}).toPNG();return {bounds:win.getBounds(),contentSize:{width,height},png:Array.from(bytes)};},request.id);
    const path=join(qa,'ui-'+request.id+'.png');await writeFile(path,Buffer.from(receipt.png));delete receipt.png;await writeFile(join(qa,'ui-'+request.id+'.json'),JSON.stringify({...receipt,path},null,2));lastUiRequest=request.id;
   }
  }catch(error){if(error.code!=='ENOENT')throw error;}
  try{reviewed=await json(ready.marker);break;}catch(error){if(error.code!=='ENOENT')throw error;}await pause(500);
 }
 assert.equal(reviewed?.state,'passed','Installed visual/user-control review remains pending');assert.deepEqual(reviewed.versions,versions);assert.equal(reviewed.debugPort,debugPort);assert.equal(reviewed.visualReviewPassed,true);report.uiReview=reviewed;report.visualReviewPassed=true;
 report.state='passed';
}catch(error){report.state='failed';report.errors.push(error.stack??String(error));process.exitCode=1;}
finally{
 await connection?.disconnect().catch(()=>{});if(sandboxProfileId)await client.stop(sandboxProfileId).catch(error=>report.errors.push('Owned sandbox profile cleanup: '+error.message));try{await quit();}catch(error){report.errors.push('Owned application normal Quit: '+error.message);report.state='failed';process.exitCode=1;}
 report.completedAt=new Date().toISOString();await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2));console.log(JSON.stringify({state:report.state,platform:'linux',versions,installerExecuted:report.installerExecuted,sandboxVerified:report.sandboxVerified,nativeKernelQualified:report.nativeKernelQualified,visualReviewPassed:report.visualReviewPassed,errors:report.errors,qaRoot:qa}));
}
