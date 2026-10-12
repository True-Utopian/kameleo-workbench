/** Original observation fixture. This records behavior; it does not change browser identity. */
export async function observeFingerprintSurfaces() {
  const n = navigator, result = {
    userAgent: n.userAgent, platform: n.platform, language: n.language,
    languages: [...n.languages], cpu: n.hardwareConcurrency, memory: n.deviceMemory ?? null,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    userAgentData: n.userAgentData ? { brands: n.userAgentData.brands, mobile: n.userAgentData.mobile, platform: n.userAgentData.platform } : null,
    screen: typeof screen === 'undefined' ? null : { width: screen.width, height: screen.height, availableWidth: screen.availWidth, availableHeight: screen.availHeight, colorDepth: screen.colorDepth, pixelDepth: screen.pixelDepth, pixelRatio: devicePixelRatio },
    canvas: null, webgl: null, webgl2: null, webgpu: null, audio: null, fonts: null, mediaDevices: null, errors: []
  };
  const attempt = async (name, operation) => { try { result[name] = await operation(); } catch (error) { result.errors.push({ surface: name, message: error.name }); } };
  const canvas = () => typeof document === 'undefined' ? new OffscreenCanvas(64,32) : Object.assign(document.createElement('canvas'),{width:64,height:32});
  const digest = async values => [...new Uint8Array(await crypto.subtle.digest('SHA-256',values))].map(value=>value.toString(16).padStart(2,'0')).join('');
  if(n.userAgentData) await attempt('highEntropy',()=>n.userAgentData.getHighEntropyValues(['architecture','bitness','model','platformVersion','uaFullVersion','fullVersionList']));
  const crop = (pixels, x, y, width, height) => {
    const output = new Uint8Array(width * height * 4);
    for (let row = 0; row < height; row++) output.set(pixels.subarray(((y + row) * 16 + x) * 4, ((y + row) * 16 + x + width) * 4), row * width * 4);
    return output;
  };
  // Return export bytes only to the owned host-side PNG decoder. Decoding them
  // through another canvas would apply a candidate's policy a second time.
  const exports = async c => {
    const blob = typeof c.convertToBlob === 'function'
      ? await c.convertToBlob({type:'image/png'})
      : await new Promise((done,reject)=>c.toBlob(value=>value ? done(value) : reject(new Error('Canvas export failed')),'image/png'));
    return {blobPng:[...new Uint8Array(await blob.arrayBuffer())],dataUrlPng:typeof c.toDataURL==='function'?c.toDataURL('image/png'):null};
  };
  await attempt('canvas',async()=>{
    const c=canvas(); c.width=16; c.height=8;
    const ctx=c.getContext('2d'); if(!ctx)return null;
    ctx.fillStyle='#396f91';ctx.fillRect(0,0,16,8);
    ctx.fillStyle='#ed7040';ctx.fillRect(3,2,5,3);
    const first=ctx.getImageData(0,0,16,8).data;
    return {first:await digest(first),repeat:await digest(ctx.getImageData(0,0,16,8).data),crop:await digest(ctx.getImageData(3,2,5,3).data),expectedCrop:await digest(crop(first,3,2,5,3)),...await exports(c)};
  });
  for (const name of ['webgl','webgl2']) await attempt(name,async()=>{
    const c=canvas();c.width=16;c.height=8;
    const gl=c.getContext(name,{alpha:false,antialias:false,preserveDrawingBuffer:true});if(!gl)return null;
    const ext=gl.getExtension('WEBGL_debug_renderer_info');
    const observed={vendor:gl.getParameter(gl.VENDOR),renderer:gl.getParameter(gl.RENDERER),unmaskedVendor:ext?gl.getParameter(ext.UNMASKED_VENDOR_WEBGL):null,unmaskedRenderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):null,version:gl.getParameter(gl.VERSION),maxTextureSize:gl.getParameter(gl.MAX_TEXTURE_SIZE)};
    try {
      gl.disable(gl.DITHER);gl.clearColor(0.2,0.4,0.6,1);gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.SCISSOR_TEST);gl.scissor(3,2,5,3);gl.clearColor(0.8,0.2,0.4,1);gl.clear(gl.COLOR_BUFFER_BIT);gl.disable(gl.SCISSOR_TEST);
      const read=(x,y,w,h)=>{const pixels=new Uint8Array(w*h*4);gl.readPixels(x,y,w,h,gl.RGBA,gl.UNSIGNED_BYTE,pixels);return pixels;};
      const first=read(0,0,16,8),repeat=read(0,0,16,8),part=read(3,2,5,3),topDown=new Uint8Array(first.length);
      // GL readPixels uses bottom-left origin; PNG exports use top-left.
      for(let y=0;y<8;y++)topDown.set(first.subarray(y*64,(y+1)*64),(7-y)*64);
      observed.readout={first:await digest(first),repeat:await digest(repeat),crop:await digest(part),expectedCrop:await digest(crop(first,3,2,5,3)),topDown:await digest(topDown),error:gl.getError(),...await exports(c)};
      return observed;
    } finally {gl.getExtension('WEBGL_lose_context')?.loseContext();}
  });
  await attempt('webgpu',async()=>{if(!n.gpu)return null;const adapter=await n.gpu.requestAdapter();return adapter?{info:{vendor:adapter.info.vendor,architecture:adapter.info.architecture,device:adapter.info.device,description:adapter.info.description},features:[...adapter.features].sort(),maxTextureDimension2D:adapter.limits.maxTextureDimension2D}:null;});
  await attempt('audio',async()=>{
    if(typeof OfflineAudioContext==='undefined')return null;
    const ctx=new OfflineAudioContext(1,4096,44100),osc=ctx.createOscillator();osc.type='triangle';osc.frequency.value=440;osc.connect(ctx.destination);osc.start();
    const buffer=await ctx.startRendering(),data=buffer.getChannelData(0),hash=await digest(data.slice().buffer),repeat=await digest(buffer.getChannelData(0).slice().buffer),copy=new Float32Array(buffer.length);
    buffer.copyFromChannel(copy,0);
    return {sampleRate:ctx.sampleRate,hash,repeat,copy:await digest(copy.buffer)};
  });
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
    for(const error of observed.errors ?? [])check(`${name}:${error.surface}-observation`,false,`Available API failed during the owned probe: ${error.message}`);
    for(const field of ['userAgent','platform','language','languages','cpu','memory','timezone','userAgentData']) check(`${name}:${field}`,JSON.stringify(observed[field])===JSON.stringify(reference[field]),'Compare observed document/frame/worker values');
    const chromeMajor=/\b(?:Chrome|Chromium)\/(\d+)/.exec(observed.userAgent)?.[1], chromiumBrand=observed.userAgentData?.brands?.find(brand=>brand.brand==='Chromium');
    if(chromeMajor&&chromiumBrand)check(`${name}:chrome-brand-version`,chromeMajor===chromiumBrand.version,'Chrome user agent and Chromium client-hint major version must agree');
    if(observed.highEntropy&&reference.highEntropy)check(`${name}:high-entropy`,JSON.stringify(observed.highEntropy)===JSON.stringify(reference.highEntropy),'Compare observed architecture, platform version and browser full versions');
    if(observed.canvas)check(`${name}:canvas-repeat`,observed.canvas.first===observed.canvas.repeat,'Repeated read-out within one context');
    if(observed.canvas?.crop)check(`${name}:canvas-crop`,observed.canvas.crop===observed.canvas.expectedCrop,'Cropped read-out agrees with corresponding full-image pixels');
    if(observed.canvas?.blobPixels)check(`${name}:canvas-blob`,observed.canvas.blobPixels===observed.canvas.first,'Independently decoded PNG agrees with Canvas2D read-out');
    if(observed.canvas?.dataUrlPixels)check(`${name}:canvas-data-url`,observed.canvas.dataUrlPixels===observed.canvas.first,'Independently decoded data URL agrees with Canvas2D read-out');
    if(observed.canvas&&reference.canvas)check(`${name}:canvas-context`,observed.canvas.first===reference.canvas.first,'Compare actual Canvas2D read-out across contexts and restarts');
    if(observed.webgl&&reference.webgl)for(const field of ['unmaskedVendor','unmaskedRenderer','maxTextureSize'])check(`${name}:webgl-${field}`,observed.webgl[field]===reference.webgl[field],'Compare graphics metadata; this does not verify masking of rendering output');
    for(const surface of ['webgl','webgl2']) {
      const readout=observed[surface]?.readout, baseline=reference[surface]?.readout;
      if(!readout)continue;
      check(`${name}:${surface}-read-error`,readout.error===0,'Owned RGBA8 readPixels completed without a GL error');
      check(`${name}:${surface}-repeat`,readout.first===readout.repeat,'Repeated GPU read-out must not accumulate changes');
      check(`${name}:${surface}-crop`,readout.crop===readout.expectedCrop,'Cropped GPU read-out agrees with full framebuffer pixels');
      if(baseline)check(`${name}:${surface}-context`,readout.first===baseline.first,'Compare owned GPU clear/read-out across contexts and restarts');
      for(const field of ['blobPixels','dataUrlPixels'])if(readout[field])check(`${name}:${surface}-${field}`,readout[field]===readout.topDown,'Independent PNG pixels agree with vertically normalized GPU read-out');
    }
    if(observed.audio?.repeat)check(`${name}:audio-repeat`,observed.audio.hash===observed.audio.repeat,'Repeated getChannelData agrees within one rendered buffer');
    if(observed.audio?.copy)check(`${name}:audio-copy`,observed.audio.hash===observed.audio.copy,'copyFromChannel agrees with getChannelData from the same rendered buffer');
    for(const field of ['webgpu','audio','fonts'])if(observed[field]&&reference[field])check(`${name}:${field}-context`,JSON.stringify(observed[field])===JSON.stringify(reference[field]),'Compare supported graphics metadata, audio read-out or text measurements');
  }
  for(const [index,request]of requests.entries()) {
    check(`request-${index}:user-agent`,request.userAgent===reference.userAgent,'HTTP user agent must agree with the initial document');
    if(request.platform&&reference.userAgentData)check(`request-${index}:platform`,request.platform===JSON.stringify(reference.userAgentData.platform),'HTTP client hint platform agrees with navigator.userAgentData');
    if(request.brands&&reference.userAgentData){const actual=[...request.brands.matchAll(/"([^"\r\n]+)";v="(\d+)"/g)].map(match=>({brand:match[1],version:match[2]}));const normalize=values=>JSON.stringify([...values].sort((a,b)=>a.brand.localeCompare(b.brand)));check(`request-${index}:brands`,normalize(actual)===normalize(reference.userAgentData.brands),'HTTP low-entropy brands agree with navigator.userAgentData');}
  }
  return {checks,mismatches:checks.filter(check=>check.state==='mismatch'),nativeProof:false,unsupportedMaskingSurfaces:['coherent-persona-generation','webgl-rendering','webgpu-rendering','audio-masking','font-masking','media-device-masking','network-leaks']};
}
