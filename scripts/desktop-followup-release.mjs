import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import update from '../desktop/update-contract.cjs';
import plugin from '../desktop/plugin-contract.cjs';

// Bounded local release evidence. No assertion of custom-kernel completion.
const root=resolve(import.meta.dirname,'..'),json=async path=>JSON.parse(await readFile(join(root,path),'utf8'));
const products={browser:(await json('packages/vesper-browser/package.json')).version,workbench:(await json('package.json')).version};
const pair=await json('test-results/desktop-followup/packaged-pair.json');
assert.equal(pair.state,'passed');assert.deepEqual(pair.versions,products);assert.deepEqual(pair.errors,[]);
const stock=await json('test-results/desktop-followup/stock-rejection.json');
assert.equal(stock.state,'failed');assert.equal(stock.nativeProof,false);
assert.ok(stock.errors.some(error=>error.includes('extension-startup-worker: native CPU')));
const linux=await json('test-results/desktop/linux-packages.json');assert.equal(linux.length,2);assert.ok(linux.every(item=>item.structurePassed));
const audit=await json('test-results/desktop-followup/production-audit.json');assert.equal(audit.metadata.vulnerabilities.total,0);
const check=await readFile(join(root,'test-results/desktop-followup/check.log'),'utf8');
const passed=[...check.matchAll(/^ℹ pass (\d+)\r?$/gm)].map(match=>Number(match[1]));
assert.equal(passed.length,2);assert.deepEqual([...check.matchAll(/^ℹ fail (\d+)\r?$/gm)].map(match=>Number(match[1])),[0,0]);
const publicKey=await readFile(join(root,'desktop/update-public-key.pem'),'utf8'),paths=[];
for(const [product,version]of Object.entries(products))for(const platform of ['win32','linux']){
 const path=platform==='win32'?`${product}/${platform}/Vesper-${product}-${version}-win32-x64-full.exe`:`${product}/${platform}/vesper-${product}_${version}_amd64.deb`;
 await update.verifyLocalUpdate(join(root,'release',path+'.vesper-update.json'),publicKey,{product,platform,arch:'x64',version:'0.0.0'});
 paths.push(path,path+'.vesper-update.json');if(platform==='linux')paths.push(`${product}/linux/Vesper-${product}-${version}-linux-x64.tar.gz`);
}
const addon=`addons/Vesper-workbench-${products.workbench}.vplugin.tgz`;
for(const platform of ['win32','linux'])await plugin.verifyPlugin(join(root,'release',addon+'.vesper-plugin.json'),publicKey,{platform,arch:'x64'});
paths.push(addon,addon+'.vesper-plugin.json',`Vesper-source-${products.workbench}.tar.gz`);
const artifacts=[];for(const path of paths)artifacts.push({path,bytes:(await stat(join(root,'release',path))).size,sha256:await update.hashFile(join(root,'release',path))});
const evidence=[];for(const path of ['test-results/desktop-followup/packaged-pair.json','test-results/desktop-followup/stock-rejection.json','test-results/desktop-followup/check.log','test-results/desktop-followup/production-audit.json','test-results/desktop/linux-packages.json'])evidence.push({path,sha256:await update.hashFile(join(root,path))});
const manifest={schemaVersion:1,author:'true-utopian',channel:'local-development',published:false,products,customCompiledKernel:false,validation:{sourceTestsPassed:passed.reduce((a,b)=>a+b,0),windowsPackagedPair:true,linuxStructure:true,linuxNativeExecution:false,stockKernelRejected:true,productionVulnerabilities:0},limitations:['Custom kernel compilation and native qualification are pending.','Upstream CDP policies do not control extension workers before their startup script.','Windows update/add-on manifests are signed locally; installers lack an Authenticode publisher certificate.','Linux packages require real Linux runtime qualification.'],artifacts,evidence};
await writeFile(join(root,'release/DESKTOP-RELEASE.json'),JSON.stringify(manifest,null,2));console.log(JSON.stringify({products,validation:manifest.validation,artifacts:artifacts.length}));
