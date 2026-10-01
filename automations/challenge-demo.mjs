import { defineAutomation } from '../dist/index.js';

export default defineAutomation({
  id: 'challenge-demo',
  title: 'Test a follow-up input',
  description: 'Open the local form, request a test code from the operator, and finish after the form is verified.',
  inputSchema: {
    type: 'object', required: ['url'], additionalProperties: false,
    properties: { url: { type: 'string', title: 'Fixture URL', minLength: 1 } },
  },
  async run({ inputs, actions, page, requestInput, done }) {
    await actions.goto(inputs.url);
    const { code } = await requestInput('Enter any six-digit test code', {
      type: 'object', required: ['code'], additionalProperties: false,
      properties: { code: { type: 'string', title: 'Test code', pattern: '^[0-9]{6}$', writeOnly: true } },
    });
    await actions.fill('[data-test="message"]', code);
    await actions.click('[data-test="save"]');
    await page.waitForFunction(expected => document.querySelector('[data-test="saved"]')?.textContent === expected, {}, code);
    await done();
  },
});
