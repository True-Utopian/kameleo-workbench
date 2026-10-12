import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { Resvg } from '@resvg/resvg-js';
const logo=await readFile(new URL('../public/vesper-mark.svg',import.meta.url),'utf8');
await writeFile(new URL('../packages/vesper-browser/public/vesper-mark.svg',import.meta.url),logo);
await mkdir(new URL('../docs/assets/',import.meta.url),{recursive:true});
const inner=logo.slice(logo.indexOf('>')+1,logo.lastIndexOf('</svg>'));
const banner=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 240" role="img" aria-labelledby="brand-title brand-desc">
<title id="brand-title">Vesper by true-utopian</title><desc id="brand-desc">An independent browser workspace with an optional automation workbench. Original night moth identity.</desc>
<rect width="1200" height="240" rx="16" fill="#181e23"/>
<svg x="40" y="48" width="144" height="144" viewBox="0 0 64 64">${inner}</svg>
<g font-family="Segoe UI,Arial,sans-serif"><text x="216" y="108" font-size="55" font-weight="650" letter-spacing="-2" fill="#eaf0ed">Vesper</text><text x="218" y="144" font-size="18" fill="#a0b3b2">Independent profiles. Repeatable workflows.</text><text x="218" y="180" font-size="14" fill="#d1b181">by true-utopian</text>
<path d="M815 62v116" stroke="#364744"/><text x="850" y="94" font-size="18" font-weight="600" fill="#b8e1d5">Browser</text><text x="850" y="118" font-size="14" fill="#a3afb6">Your local profile workspace</text><text x="850" y="152" font-size="18" font-weight="600" fill="#e2be87">Workbench</text><text x="850" y="176" font-size="14" fill="#a3afb6">Automation, added as a plug-in</text></g></svg>\n`;
await writeFile(new URL('../docs/assets/vesper-banner.svg',import.meta.url),banner);
await writeFile(new URL('../desktop/icon.png',import.meta.url),new Resvg(logo,{fitTo:{mode:'width',value:256}}).render().asPng());
console.log('Shared SVG mark, README banner and desktop icon generated.');
