const { defineAutomation } = await import(process.env.VESPER_SDK_MODULE ?? '../dist/index.js');

export default defineAutomation({
  id: 'inspect',
  title: 'Open and inspect a browser',
  description: 'Open a page, inspect the headed browser, then choose Finish + save to export its profile.',
  inputSchema: {
    type: 'object', required: ['url'], additionalProperties: false,
    properties: {
      url: { type: 'string', title: 'Page URL', minLength: 1 },
      engine: { type: 'string', title: 'Browser engine', enum: ['chromium','brave','vesper'], default: 'chromium' },
      identityPreset:{type:'string',title:'Hardware identity (Vesper)',enum:['custom','native','desktop-4','desktop-8'],oneOf:[{const:'custom',title:'Custom settings'},{const:'native',title:'Native hardware'},{const:'desktop-4',title:'4 threads / 4 GB'},{const:'desktop-8',title:'8 threads / 8 GB'}],default:'custom',description:'Presets retain this kernel’s browser version, OS, screen and GPU. CPU and memory stay paired; clear manual values or enter the matching pair.'},
      protection: { type: 'string', title: 'Native fingerprint protection (Brave / Vesper)', enum: ['default','standard','off'], default: 'default' },
      webgl: {type:'string',title:'GPU identity exposure (Vesper)',enum:['upstream','restricted'],default:'upstream',description:'Restricted hides the WebGL debug renderer extension. Requires a qualified Vesper kernel.'},
      audio: {type:'string',title:'Offline audio identity (Vesper)',enum:['upstream','seeded'],default:'upstream',description:'Seeded preserves one audio identity per profile. Covers completed offline output.'},
      fonts: {type:'string',title:'Local font discovery (Vesper)',enum:['upstream','restricted'],default:'upstream',description:'Restricted hides extra local families, CSS local faces and font enumeration. Essential families remain available.'},
      locale: { type: 'string', title: 'Language (optional)' },
      timezone: { type: 'string', title: 'Timezone (optional)' },
      deviceMemory: { type: 'integer', title: 'Device memory in GB (Vesper only)', enum: [2,4,8,16,32] },
      cpu: { type: 'integer', title: 'CPU threads (optional)', minimum: 1, maximum: 64 },
      extensions: { type: 'array', title: 'Local extension package IDs (optional)', maxItems: 20, uniqueItems: true, items: { type: 'string', pattern: '^[a-f0-9]{64}$' } },
      savedProxyId: { type: 'string', title: 'Saved Browser proxy ID (optional)', pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' },
      savedProxyRevision: { type: 'integer', title: 'Saved proxy revision', minimum:1 },
    },
    dependencies: { savedProxyId:['savedProxyRevision'], savedProxyRevision:['savedProxyId'] },
    allOf: [...['webgl','audio','fonts'].map(key=>({if:{required:[key],properties:{[key]:{const:key==='audio'?'seeded':'restricted'}}},then:{required:['engine'],properties:{engine:{const:'vesper'},protection:{enum:['default','standard']}}}})),
      {if:{required:['identityPreset'],properties:{identityPreset:{enum:['native','desktop-4','desktop-8']}}},then:{required:['engine'],properties:{engine:{const:'vesper'}}}},
      ...[['native',null],['desktop-4',4],['desktop-8',8]].map(([preset,value])=>({if:{required:['identityPreset'],properties:{identityPreset:{const:preset}}},then:{properties:{cpu:value===null?false:{const:value},deviceMemory:value===null?false:{const:value}}}})),
    ],
  },
  profile: ({ inputs }) => ({
    engine: inputs.engine || 'chromium',
    ...(inputs.identityPreset ? {identityPreset:inputs.identityPreset} : {}),
    ...(inputs.savedProxyId ? { savedProxy:{ id:inputs.savedProxyId,revision:inputs.savedProxyRevision } } : {}),
    ...(inputs.extensions ? { extensions: inputs.extensions } : {}),
    ...((inputs.protection&&inputs.protection!=='default')||inputs.webgl==='restricted'||inputs.audio==='seeded'||inputs.fonts==='restricted' ? {fingerprint:{protection:inputs.protection&&inputs.protection!=='default'?inputs.protection:'standard',...(inputs.webgl==='restricted'?{webgl:'restricted'}:{}),...(inputs.audio==='seeded'?{audio:'seeded'}:{}),...(inputs.fonts==='restricted'?{fonts:'restricted'}:{})}}:{}),
    ...(inputs.locale ? { locale: inputs.locale } : {}),
    ...(inputs.timezone ? { timezone: inputs.timezone } : {}),
    ...((inputs.cpu || inputs.deviceMemory) ? { environment: { ...(inputs.cpu ? { hardwareConcurrency: inputs.cpu } : {}), ...(inputs.deviceMemory ? { deviceMemory: inputs.deviceMemory } : {}), webRTC: 'proxy-only' } } : {}),
  }),
  async run({ inputs, actions, log, waitForFinish }) {
    await actions.goto(inputs.url);
    log('Page opened. Waiting for the operator to finish.');
    await waitForFinish();
  },
});
