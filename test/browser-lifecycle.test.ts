import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { withBrowserConnection } from '../src/browser-lifecycle.js';
class Connection extends EventEmitter { connected = true; exit() { this.connected = false; this.emit('disconnected'); } }
test('an exited browser never starts an automation', async () => {
  const browser = new Connection(); browser.connected = false;
  let started = false, aborted = false;
  await assert.rejects(withBrowserConnection(browser, async () => { started = true; }, () => { aborted = true; }), /connection ended/);
  assert.equal(started, false); assert.equal(aborted, true); assert.equal(browser.listenerCount('disconnected'), 0);
});
test('browser loss ends an idle automation and signals pending work', async () => {
  const browser = new Connection(); let aborts = 0, started!: () => void;
  const ready = new Promise<void>(done => { started = done; });
  const pending = withBrowserConnection(browser, async () => { started(); await new Promise(() => {}); }, () => { aborts++; });
  const rejected = assert.rejects(pending, /connection ended/);
  await ready; browser.exit(); await rejected;
  assert.equal(aborts, 1); assert.equal(browser.listenerCount('disconnected'), 0);
});
test('completion removes the watcher before an intentional later disconnect', async () => {
  const browser = new Connection(); let aborts = 0;
  assert.equal(await withBrowserConnection(browser, async () => 'finished', () => { aborts++; }), 'finished');
  browser.exit(); assert.equal(aborts, 0); assert.equal(browser.listenerCount('disconnected'), 0);
});
test('an automation error retains its failure and removes the watcher', async () => {
  const browser = new Connection(), failure = new Error('Owned operation failed');
  await assert.rejects(withBrowserConnection(browser, async () => { throw failure; }, () => {}), error => error === failure);
  assert.equal(browser.listenerCount('disconnected'), 0);
});
test('disconnect cannot strand the worker if cancellation itself throws', async () => {
  const browser = new Connection(); let started!: () => void;
  const ready = new Promise<void>(done => { started = done; });
  const pending = withBrowserConnection(browser, async () => { started(); await new Promise(() => {}); }, () => { throw Error('Owned cancellation failed'); });
  const rejected = assert.rejects(pending, /connection ended/); await ready;
  assert.doesNotThrow(() => browser.exit()); await rejected;
  assert.equal(browser.listenerCount('disconnected'), 0);
});
