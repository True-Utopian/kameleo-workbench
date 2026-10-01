import { defineAutomation } from '../dist/index.js';

export default defineAutomation({
  id: 'inspect',
  title: 'Open and inspect a browser',
  description: 'Open a page, inspect the headed browser, then choose Finish + save to export its profile.',
  inputSchema: {
    type: 'object', required: ['url'], additionalProperties: false,
    properties: { url: { type: 'string', title: 'Page URL', minLength: 1 } },
  },
  async run({ inputs, actions, log, waitForFinish }) {
    await actions.goto(inputs.url);
    log('Page opened. Waiting for the operator to finish.');
    await waitForFinish();
  },
});
