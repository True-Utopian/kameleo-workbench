import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
import { createActions, type PacePreset } from './actions.js';
import type { Automation, JsonSchema } from './automation.js';

interface Start { type: 'start'; automationPath: string; engineUrl: string; profileId: string; inputs: Record<string, unknown>; preset: PacePreset }
const requests = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
let counter = 0;
const abort = new AbortController();
class Finished extends Error {}
function request(type: string, extra: Record<string, unknown> = {}): Promise<unknown> {
  const id = String(++counter);
  return new Promise((resolve, reject) => { requests.set(id, { resolve, reject }); process.send?.({ type, id, ...extra }); });
}
process.on('message', (message: unknown) => {
  const msg = message as Record<string, unknown>;
  if (msg.type === 'reply') {
    const pending = requests.get(String(msg.id)); requests.delete(String(msg.id));
    if (msg.error) pending?.reject(new Error(String(msg.error))); else pending?.resolve(msg.value);
  } else if (msg.type === 'cancel') {
    abort.abort(); for (const pending of requests.values()) pending.reject(new Error('Cancelled'));
  } else if (msg.type === 'start') { void run(message as Start); }
});
process.on('disconnect', () => process.exit(1));
async function run(message: Start) {
  let browser: Awaited<ReturnType<typeof puppeteer.connect>> | undefined;
  let save = false;
  try {
    const loaded = await import(pathToFileURL(message.automationPath).href);
    const automation = (loaded.default ?? loaded.automation) as Automation;
    const endpoint = new URL(message.engineUrl); endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
    endpoint.pathname = `/puppeteer/${message.profileId}`; endpoint.search = ''; endpoint.hash = '';
    browser = await puppeteer.connect({ browserWSEndpoint: endpoint.href, defaultViewport: null });
    const pages = await browser.pages(); const page = pages[0] ?? await browser.newPage();
    const checkpoint = async () => { abort.signal.throwIfAborted(); await request('checkpoint'); abort.signal.throwIfAborted(); };
    const done = async (): Promise<never> => { throw new Finished(); };
    await automation.run({
      inputs: message.inputs, browser, page, signal: abort.signal,
      actions: createActions(page, { preset: message.preset, signal: abort.signal, checkpoint }), checkpoint,
      log: message => { process.send?.({ type: 'log', message: String(message) }); },
      requestInput: async (title: string, fields: JsonSchema) => await request('input', { title, fields }) as Record<string, unknown>,
      done, waitForFinish: async () => { await request('wait_finish'); return done(); },
    });
    process.send?.({ type: 'failure', message: 'Automation returned without calling done() or waitForFinish().' });
  } catch (error) {
    if (error instanceof Finished) save = true;
    else process.send?.({ type: 'failure', message: 'Automation failed. Review the script and retry with corrected inputs.' });
  } finally {
    try { await browser?.disconnect(); } catch { /* Parent still owns engine shutdown. */ }
    process.send?.({ type: 'finished', save }, () => process.exit(save ? 0 : 1));
  }
}
