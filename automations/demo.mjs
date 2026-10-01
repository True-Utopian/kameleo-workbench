import { defineAutomation } from '../dist/index.js';

export default defineAutomation({
  id: 'demo',
  title: 'Fill and verify a form',
  description: 'Open your local demo fixture, enter a non-secret message, verify its saved state, then export the profile.',
  inputSchema: { type: 'object', required: ['message'], additionalProperties: false, properties: { url: { type: 'string', title: 'Fixture URL', default: process.env.DEMO_URL ?? 'http://127.0.0.1:3180/demo', minLength: 1 }, message: { type: 'string', title: 'Message', minLength: 1 } } },
  preset: 'natural-fast',
  async run({ inputs, page, actions, log, done }) {
    await actions.goto(inputs.url || process.env.DEMO_URL || 'http://127.0.0.1:3180/demo');
    await actions.fill('[data-test="message"]', inputs.message);
    await actions.click('[data-test="save"]');
    await page.waitForFunction(expected => document.querySelector('[data-test="saved"]')?.textContent === expected, {}, inputs.message);
    log('The fixture confirmed the saved value.');
    await done();
  },
});
