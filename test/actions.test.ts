import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'puppeteer-core';
import { createActions, resolvePace } from '../src/actions.js';

test('pacing is bounded and fast adds no artificial delay', () => {
  assert.equal(resolvePace('fast').typingDelayMs, 0); assert.equal(resolvePace('fast').actionDelayMs, 0); assert.equal(resolvePace('fast').pointerDurationMs, 0);
  assert.equal(resolvePace({ typingDelayMs: 7, actionDelayMs: 12 }).typingDelayMs, 7);
  for (const value of [-1, Infinity, NaN, 10001]) assert.throws(() => resolvePace({ typingDelayMs: value }));
});
test('abort at a checkpoint prevents a browser click', async () => {
  let clicked = false; const controller = new AbortController();
  const page = { waitForSelector: async () => {}, click: async () => { clicked = true; } } as unknown as Page;
  const actions = createActions(page, { signal: controller.signal, checkpoint: async () => { controller.abort(); } });
  await assert.rejects(actions.click('button')); assert.equal(clicked, false);
});
test('typing checks cancellation between characters', async () => {
  const controller = new AbortController(); const typed: string[] = [];
  const page = { waitForSelector: async () => {}, focus: async () => {}, keyboard: { type: async (character: string) => { typed.push(character); controller.abort(); } } } as unknown as Page;
  const actions = createActions(page, { signal: controller.signal, preset: { typingDelayMs: 1 } });
  await assert.rejects(actions.type('input', 'abc')); assert.deepEqual(typed, ['a']);
});
test('fast typing is one batch while custom jitter is deterministic and bounded', async () => {
  const typed: { text: string; delay: number }[] = [];
  const page = { waitForSelector: async () => {}, focus: async () => {}, keyboard: { type: async (text: string, options: { delay: number }) => { typed.push({ text, delay: options.delay }); } } } as unknown as Page;
  const fast = createActions(page); await fast.type('input', 'abc'); assert.deepEqual(typed, [{ text: 'abc', delay: 0 }]);
  typed.length = 0;
  const custom = createActions(page, { preset: { typingDelayMs: 10, typingJitterMs: 4 }, random: () => 1 });
  await custom.type('input', 'ab'); assert.deepEqual(typed, [{ text: 'a', delay: 14 }, { text: 'b', delay: 14 }]);
});
test('pointer movement reaches target and disposes its element before click', async () => {
  const moves: number[][] = []; let disposed = false; let clicked = false;
  const page = { waitForSelector: async () => {}, $: async () => ({ scrollIntoView: async () => {}, boundingBox: async () => ({ x: 10, y: 20, width: 20, height: 20 }), dispose: async () => { disposed = true; } }), mouse: { move: async (x: number, y: number) => { moves.push([x, y]); } }, click: async () => { assert.ok(disposed); clicked = true; } } as unknown as Page;
  await createActions(page, { preset: { pointerSteps: 3 } }).click('button');
  assert.equal(moves.length, 3); assert.deepEqual(moves[2], [20, 30]); assert.ok(clicked);
});
