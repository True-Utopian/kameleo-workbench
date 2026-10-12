import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
const root=resolve(import.meta.dirname,'..'),file=resolve(root,'docs/status.json');
const data=JSON.parse(await readFile(file,'utf8')),seen=new Set(),colors={verified:'#60b68b',source_tested:'#67a3b1',in_progress:'#d0ae75',planned:'#36444e'};
if(data.schemaVersion!==1||!/^\d{4}-\d{2}-\d{2}$/.test(data.updated))throw new Error('Invalid status inventory');
const counts=Object.fromEntries(Object.keys(colors).map(state=>[state,0]));
for(const group of data.groups)for(const check of group.checks){if(seen.has(check.id)||!Object.hasOwn(colors,check.state)||!check.name||check.state!=='planned'&&!check.evidence)throw new Error('Invalid/duplicate or unsupported status check '+check.id);seen.add(check.id);counts[check.state]++;if(check.evidence)await readFile(resolve(root,check.evidence));}
const escape=text=>String(text).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[char]));
const out=[];
out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" role="img" aria-labelledby="title description"><title id="title">Vesper acceptance status</title><desc id="description">${escape(data.scope)} ${Object.entries(counts).map(([name,count])=>name+': '+count).join(', ')}.</desc><rect width="1200" height="630" rx="14" fill="#181e23"/><g font-family="Segoe UI,Arial,sans-serif"><text x="30" y="39" font-size="20" font-weight="600" fill="#eaf0ed">Acceptance status</text><text x="1170" y="37" text-anchor="end" font-size="13" fill="#a4b2b9">${escape(data.updated)} · ${seen.size} named checks</text>`);
let legendX=30;for(const [state,color]of Object.entries(colors)){const label={verified:'Desktop verified',source_tested:'Source tested',in_progress:'In progress',planned:'Planned'}[state];out.push(`<rect x="${legendX}" y="57" width="10" height="10" rx="2" fill="${color}"/><text x="${legendX+17}" y="67" font-size="12" fill="#b9c6cb">${label} ${counts[state]}</text>`);legendX+=state==='source_tested'?196:state==='verified'?214:180;}
for(const [panelIndex,product]of ['Browser','Workbench'].entries()){
 const x=30+panelIndex*585,groups=data.groups.filter(group=>group.product===product),accepted=groups.flatMap(g=>g.checks).filter(c=>c.state==='verified').length,total=groups.flatMap(g=>g.checks).length;
 out.push(`<text x="${x}" y="107" font-size="17" font-weight="600" fill="${panelIndex?'#e2be87':'#b8e1d5'}">Vesper ${product}</text><text x="${x+555}" y="106" text-anchor="end" font-size="12" fill="#a4b2b9">${accepted}/${total} desktop verified</text>`);
 for(const [i,group]of groups.entries()){
  const gx=x+(i%2)*282,gy=125+Math.floor(i/2)*143,gw=i===4?555:273;
  out.push(`<rect x="${gx}" y="${gy}" width="${gw}" height="132" rx="5" fill="#20282e" stroke="#344249"/><text x="${gx+12}" y="${gy+23}" font-size="13" font-weight="600" fill="#dce7e5">${escape(group.name)}</text>`);
  const cols=i===4?8:4,tileW=i===4?64:60;
  group.checks.forEach((check,index)=>{const tx=gx+12+(index%cols)*(tileW+3),ty=gy+35+Math.floor(index/cols)*21;out.push(`<rect x="${tx}" y="${ty}" width="${tileW}" height="18" rx="2" fill="${colors[check.state]}"><title>${escape(check.name+': '+data.definitions[check.state])}</title></rect>`);});
  out.push(`<text x="${gx+12}" y="${gy+120}" font-size="10" fill="#9cadb5">${group.checks.filter(c=>c.state==='verified').length} verified · ${group.checks.length} checks</text>`);
 }
}
out.push(`<text x="30" y="595" font-size="12" fill="#b7c3c8">One tile = one named acceptance check. Source tests do not establish native-kernel or vendor parity.</text><text x="30" y="615" font-size="11" fill="#8ea3ad">The inventory grows as requirements become known. Open the checklist for the definition and evidence behind each tile.</text></g></svg>\n`);
const svg=out.join(''),summary=['# Status inventory','',`Updated ${data.updated}.`, '',data.scope,'',...data.groups.flatMap(group=>[`## ${group.product}: ${group.name}`,'','| Acceptance check | State | Evidence |','| --- | --- | --- |',...group.checks.map(check=>`| ${check.name} | ${check.state.replaceAll('_',' ')} | ${check.evidence?`[Evidence](../${check.evidence})`:'Pending'} |`),''])].join('\n').trimEnd()+'\n';
await mkdir(resolve(root,'docs/assets'),{recursive:true});
if(process.argv.includes('--check')){if(await readFile(resolve(root,'docs/assets/status.svg'),'utf8')!==svg||await readFile(resolve(root,'docs/status.md'),'utf8')!==summary)throw new Error('Run node scripts/readme-status.mjs to refresh status assets');}
else{await writeFile(resolve(root,'docs/assets/status.svg'),svg);await writeFile(resolve(root,'docs/status.md'),summary);}
console.log(JSON.stringify({checks:seen.size,counts,generated:!process.argv.includes('--check')}));
