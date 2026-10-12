import { readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import contract from '../desktop/update-contract.cjs';
import pluginContract from '../desktop/plugin-contract.cjs';

const root = resolve(import.meta.dirname, '..');
const version = async path => JSON.parse(await readFile(join(root, path), 'utf8')).version;
const products = { browser: await version('packages/vesper-browser/package.json'), workbench: await version('package.json') };
const paths = [];
for (const [product, v] of Object.entries(products)) {
  const win = `${product}/win32/Vesper-${product}-${v}-win32-x64-full.exe`;
  const deb = `${product}/linux/vesper-${product}_${v}_amd64.deb`;
  paths.push(win, win + '.vesper-update.json', deb, deb + '.vesper-update.json', `${product}/linux/Vesper-${product}-${v}-linux-x64.tar.gz`);
  for (const [platform, relative] of [['win32', win], ['linux', deb]]) {
    const key = await readFile(join(root, '.desktop-build', product, platform, 'desktop/update-public-key.pem'), 'utf8');
    await contract.verifyLocalUpdate(join(root, 'release', relative + '.vesper-update.json'), key, {product, platform, arch:'x64', version:'0.0.0'});
  }
}
paths.push(`Vesper-source-${products.workbench}.tar.gz`);
const addon=`addons/Vesper-workbench-${products.workbench}.vplugin.tgz`;
paths.push(addon,addon+'.vesper-plugin.json');
await pluginContract.verifyPlugin(join(root,'release',addon+'.vesper-plugin.json'),await readFile(join(root,'.desktop-build/browser/win32/desktop/update-public-key.pem'),'utf8'),{platform:'win32',arch:'x64'});
const artifacts = [];
for (const path of paths) {
  const file = join(root, 'release', path);
  artifacts.push({path, bytes:(await stat(file)).size, sha256:await contract.hashFile(file)});
}
// Qualification fields come from recorded local acceptance, never inferred by a build.
const acceptance = JSON.parse(await readFile(join(root, process.argv[2] ?? 'test-results/browser-host/installed-results.json'), 'utf8'));
if (Object.entries(products).some(([product,version])=>acceptance.versions?.[product]!==version)) throw new Error('Installed acceptance versions do not match this release');
if (!acceptance.allSaved || !acceptance.scheduleCompleted || !acceptance.restartPersistence) throw new Error('Installed Windows acceptance is incomplete');
if(!acceptance.uiRefinements||!acceptance.installedPayloadMatchesSource||!acceptance.publishedStatusSurvivesRestart||acceptance.pageErrors?.length||!Number.isInteger(acceptance.savedRuns)||acceptance.savedRuns<1)throw new Error('Installed UI acceptance is incomplete');
if(!acceptance.browserAddonLifecycle||acceptance.addonSha256!==artifacts.find(item=>item.path===addon).sha256)throw new Error('Installed Workbench add-on acceptance is incomplete or stale');
if(!acceptance.addonPayloadMatchesSource||!acceptance.standaloneInstalledAcceptance||!acceptance.standalonePayloadMatchesSource)throw new Error('Add-on or standalone Workbench payload acceptance is incomplete');
for(const product of Object.keys(products)){
  const installer=artifacts.find(item=>item.path.startsWith(product+'/win32/')&&item.path.endsWith('.exe'));
  if(acceptance.windowsInstallerSha256?.[product]!==installer.sha256)throw new Error(`The ${product} Windows installer changed after installed acceptance`);
}
const log=await readFile(join(root,'test-results/vesper-browser-addon-check.log'),'utf8');
const passes=[...log.matchAll(/^ℹ pass (\d+)\r?$/gm)].map(match=>Number(match[1]));
const failures=[...log.matchAll(/^ℹ fail (\d+)\r?$/gm)].map(match=>Number(match[1]));
const skipped=[...log.matchAll(/^ℹ skipped (\d+)\r?$/gm)].map(match=>Number(match[1]));
if(passes.length!==2||failures.length!==2||failures.some(Boolean)||skipped.length!==2)throw new Error('The recorded Browser/Workbench check is incomplete');
const audit=JSON.parse(await readFile(join(root,'test-results/browser-host/production-audit.json'),'utf8'));
if(audit.metadata?.vulnerabilities?.total!==0)throw new Error('Production dependency audit did not pass');
const release = {
  author:'true-utopian', license:'MIT', channel:'local-development', published:false, products, apiVersion:'1.0',
  windows:{installer:true,bundledChromium:true,nativeAcceptance:true,unsigned:true},
  linux:{deb:true,portableTar:true,architecture:'amd64',nativeAcceptance:false,qualification:'Package structure passed; native Linux execution pending'},
  updates:{offlineSignedManifests:true,installerDigestsVerified:true,fullInteractiveUpdateCycle:false,hostedFeed:false},
  addons:{workbench:true,signedLocalPackage:true,embeddedNativeView:true,windowsInstalledAcceptance:true,linuxNativeAcceptance:false},
  checks:{browserPassed:passes[0],workbenchPassed:passes[1],workbenchSkipped:skipped[1],productionAudit:audit.metadata.vulnerabilities.total,installedSavedRuns:acceptance.savedRuns,uiNavigation:!!acceptance.uiNavigation,uiRefinements:!!acceptance.uiRefinements},
  implemented:['profile organization and templates','reversible trash and bulk operations','cookie tools','native environment policies and reports','optional official Brave engine','visual flow editor','durable elapsed-interval scheduling','signed offline updates','persistent navigation','tabbed profile settings','full workspace flow and schedule pages','dark profile workspace','persisted favorites and inline metadata edits','optional signed Workbench add-on inside Browser'],
  pending:['Original coherent native masking engine','Firefox/mobile engines','Extension management','Team roles/cloud sharing','Native Linux qualification','AppImage','Calendar schedules/system wakeup','Hosted updates/automatic rollback','Full interactive update-cycle qualification','Comparative capacity benchmarks','Editable reusable proxy inventory','Master/follower action synchronizer','Cookie collection helpers','Theme selection/localization/custom columns'],
  artifacts
};
await writeFile(join(root, 'release/RELEASE.json'), JSON.stringify(release,null,2)+'\n');
await writeFile(join(root, 'release/SHA256SUMS'), artifacts.map(x=>`${x.sha256}  ${x.path}`).join('\n')+'\n');
console.log(`Local Vesper release verified: ${artifacts.length} artifacts, no publication`);
