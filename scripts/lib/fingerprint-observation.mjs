/** Original observation fixture. This records behavior; it does not change browser identity. */
export async function observeFingerprintSurfaces() {
  const n = navigator, result = {
    userAgent: n.userAgent, platform: n.platform, language: n.language,
    languages: [...n.languages], cpu: n.hardwareConcurrency, memory: n.deviceMemory ?? null,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    userAgentData: n.userAgentData ? { brands: n.userAgentData.brands, mobile: n.userAgentData.mobile, platform: n.userAgentData.platform } : null,
    screen: typeof screen === 'undefined' ? null : { width: screen.width, height: screen.height, availableWidth: screen.availWidth, availableHeight: screen.availHeight, colorDepth: screen.colorDepth, pixelDepth: screen.pixelDepth, pixelRatio: devicePixelRatio },
    canvas: null, webgl: null, webgpu: null, audio: null, fonts: null, mediaDevices: null, errors: []
  };
  const attempt = async (name, operation) => { try { result[name] = await operation(); } catch (error) { result.errors.push({ surface: name, message: error.name }); } };
  const canvas = () => typeof document === 'undefined' ? new OffscreenCanvas(64,32) : Object.assign(document.createElement('canvas'),{width:64,height:32});
  const digest = async values => [...new Uint8Array(await crypto.subtle.digest('SHA-256',values))].map(value=>value.toString(16).padStart(2,'0')).join('');
  if(n.userAgentData) await attempt('highEntropy',()=>n.userAgentData.getHighEntropyValues(['architecture','bitness','model','platformVersion','uaFullVersion','fullVersionList']));
  await attempt('canvas',async()=>{const c=canvas(),ctx=c.getContext('2d'); if(!ctx)return null;ctx.fillStyle='#396f91';ctx.fillRect(0,0,64,32);ctx.fillStyle='#eee';ctx.font='12px sans-serif';ctx.fillText('Vesper',2,20);return {first:await digest(ctx.getImageData(0,0,64,32).data),repeat:await digest(ctx.getImageData(0,0,64,32).data)};});
  await attempt('webgl',()=>{const gl=canvas().getContext('webgl');if(!gl)return null;const ext=gl.getExtension('WEBGL_debug_renderer_info');const observed={vendor:gl.getParameter(gl.VENDOR),renderer:gl.getParameter(gl.RENDERER),unmaskedVendor:ext?gl.getParameter(ext.UNMASKED_VENDOR_WEBGL):null,unmaskedRenderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):null,version:gl.getParameter(gl.VERSION),maxTextureSize:gl.getParameter(gl.MAX_TEXTURE_SIZE)};gl.getExtension('WEBGL_lose_context')?.loseContext();return observed;});
  await attempt('webgpu',async()=>{if(!n.gpu)return null;const adapter=await n.gpu.requestAdapter();return adapter?{info:{vendor:adapter.info.vendor,architecture:adapter.info.architecture,device:adapter.info.device,description:adapter.info.description},features:[...adapter.features].sort(),maxTextureDimension2D:adapter.limits.maxTextureDimension2D}:null;});
  await attempt('audio',async()=>{if(typeof OfflineAudioContext==='undefined')return null;const ctx=new OfflineAudioContext(1,4096,44100),osc=ctx.createOscillator();osc.type='triangle';osc.frequency.value=440;osc.connect(ctx.destination);osc.start();const data=(await ctx.startRendering()).getChannelData(0);return {sampleRate:ctx.sampleRate,hash:await digest(data.buffer)};});
  await attempt('fonts',()=>{if(typeof document==='undefined')return null;const ctx=canvas().getContext('2d');return ['monospace','serif','sans-serif','Arial','Times New Roman'].map(family=>{ctx.font=`16px "${family}"`;return {family,width:ctx.measureText('Vesper 0123456789').width};});});
  await attempt('mediaDevices',async()=>{if(!n.mediaDevices?.enumerateDevices)return null;return (await n.mediaDevices.enumerateDevices()).map(device=>({kind:device.kind,labelPresent:!!device.label,deviceIdPresent:!!device.deviceId,groupIdPresent:!!device.groupId}));});
  return result;
}

/** Context/header consistency diagnostics, never proof of native masking or vendor parity. */
export function assessFingerprintConsistency(contexts, requests) {
  const checks=[], reference=contexts.main;
  if(!reference)throw Error('A main document observation is required');
  const check=(id,passed,detail)=>checks.push({id,state:passed?'consistent':'mismatch',detail});
  for(const [name,observed]of Object.entries(contexts)) {
    for(const field of ['userAgent','platform','language','languages','cpu','memory','timezone','userAgentData']) check(`${name}:${field}`,JSON.stringify(observed[field])===JSON.stringify(reference[field]),'Compare observed document/frame/worker values');
    const chromeMajor=/\b(?:Chrome|Chromium)\/(\d+)/.exec(observed.userAgent)?.[1], chromiumBrand=observed.userAgentData?.brands?.find(brand=>brand.brand==='Chromium');
    if(chromeMajor&&chromiumBrand)check(`${name}:chrome-brand-version`,chromeMajor===chromiumBrand.version,'Chrome user agent and Chromium client-hint major version must agree');
    if(observed.highEntropy&&reference.highEntropy)check(`${name}:high-entropy`,JSON.stringify(observed.highEntropy)===JSON.stringify(reference.highEntropy),'Compare observed architecture, platform version and browser full versions');
    if(observed.canvas)check(`${name}:canvas-repeat`,observed.canvas.first===observed.canvas.repeat,'Repeated read-out within one context');
    if(observed.canvas&&reference.canvas)check(`${name}:canvas-context`,observed.canvas.first===reference.canvas.first,'Compare actual Canvas2D read-out across contexts and restarts');
    if(observed.webgl&&reference.webgl)for(const field of ['unmaskedVendor','unmaskedRenderer','maxTextureSize'])check(`${name}:webgl-${field}`,observed.webgl[field]===reference.webgl[field],'Compare graphics metadata; this does not verify masking of rendering output');
    for(const field of ['webgpu','audio','fonts'])if(observed[field]&&reference[field])check(`${name}:${field}-context`,JSON.stringify(observed[field])===JSON.stringify(reference[field]),'Compare supported graphics metadata, audio read-out or text measurements');
  }
  for(const [index,request]of requests.entries()) {
    check(`request-${index}:user-agent`,request.userAgent===reference.userAgent,'HTTP user agent must agree with the initial document');
    if(request.platform&&reference.userAgentData)check(`request-${index}:platform`,request.platform===JSON.stringify(reference.userAgentData.platform),'HTTP client hint platform agrees with navigator.userAgentData');
    if(request.brands&&reference.userAgentData){const actual=[...request.brands.matchAll(/"([^"\r\n]+)";v="(\d+)"/g)].map(match=>({brand:match[1],version:match[2]}));const normalize=values=>JSON.stringify([...values].sort((a,b)=>a.brand.localeCompare(b.brand)));check(`request-${index}:brands`,normalize(actual)===normalize(reference.userAgentData.brands),'HTTP low-entropy brands agree with navigator.userAgentData');}
  }
  return {checks,mismatches:checks.filter(check=>check.state==='mismatch'),nativeProof:false,unsupportedMaskingSurfaces:['coherent-persona-generation','webgl-rendering','webgpu-rendering','audio-masking','font-masking','media-device-masking','network-leaks']};
}
