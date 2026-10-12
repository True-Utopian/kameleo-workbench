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
      protection: { type: 'string', title: 'Native fingerprint protection (Brave / Vesper)', enum: ['default','standard','off'], default: 'default' },
      locale: { type: 'string', title: 'Language (optional)' },
      timezone: { type: 'string', title: 'Timezone (optional)' },
      deviceMemory: { type: 'integer', title: 'Device memory in GB (Vesper only)', enum: [2,4,8,16,32] },
      cpu: { type: 'integer', title: 'CPU threads (optional)', minimum: 1, maximum: 64 },
      extensions: { type: 'array', title: 'Local extension package IDs (optional)', maxItems: 20, uniqueItems: true, items: { type: 'string', pattern: '^[a-f0-9]{64}$' } },
      savedProxyId: { type: 'string', title: 'Saved Browser proxy ID (optional)', pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' },
      savedProxyRevision: { type: 'integer', title: 'Saved proxy revision', minimum:1 },
    },
    dependencies: { savedProxyId:['savedProxyRevision'], savedProxyRevision:['savedProxyId'] },
  },
  profile: ({ inputs }) => ({
    engine: inputs.engine || 'chromium',
    ...(inputs.savedProxyId ? { savedProxy:{ id:inputs.savedProxyId,revision:inputs.savedProxyRevision } } : {}),
    ...(inputs.extensions ? { extensions: inputs.extensions } : {}),
    ...(inputs.protection && inputs.protection !== 'default' ? { fingerprint: { protection: inputs.protection } } : {}),
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
