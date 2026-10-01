import type { Page } from 'puppeteer-core';
import { setTimeout as delay } from 'node:timers/promises';

export interface Pace { typingDelayMs: number; typingJitterMs: number; actionDelayMs: number; actionJitterMs: number; pointerDurationMs: number; pointerSteps: number; clickDelayMs: number }
export type PacePreset = 'fast' | 'natural-fast' | 'natural' | Partial<Pace>;
export function resolvePace(preset: PacePreset = 'fast'): Pace {
  const fast: Pace = { typingDelayMs: 0, typingJitterMs: 0, actionDelayMs: 0, actionJitterMs: 0, pointerDurationMs: 0, pointerSteps: 1, clickDelayMs: 0 };
  const values: Record<string, Pace> = { fast, 'natural-fast': { typingDelayMs: 15, typingJitterMs: 10, actionDelayMs: 60, actionJitterMs: 25, pointerDurationMs: 80, pointerSteps: 6, clickDelayMs: 20 }, natural: { typingDelayMs: 60, typingJitterMs: 25, actionDelayMs: 180, actionJitterMs: 60, pointerDurationMs: 250, pointerSteps: 14, clickDelayMs: 50 } };
  const pace = typeof preset === 'string' ? values[preset] : { ...fast, ...preset };
  if (!pace || Object.values(pace).some(value => !Number.isFinite(value) || value < 0 || value > 10_000) || !Number.isInteger(pace.pointerSteps) || pace.pointerSteps < 1 || pace.pointerSteps > 100) throw new Error('Invalid pacing preset');
  return { ...pace };
}
export interface Actions {
  goto(url: string): Promise<void>;
  click(selector: string): Promise<void>;
  fill(selector: string, text: string): Promise<void>;
  type(selector: string, text: string): Promise<void>;
  press(key: Parameters<Page['keyboard']['press']>[0]): Promise<void>;
  waitFor(selector: string): Promise<void>;
  moveTo(selector: string): Promise<void>;
  setPace(preset: PacePreset): void;
  checkpoint(): Promise<void>;
}
/** Cooperative helpers. Raw Puppeteer remains available and must call checkpoint to pause. */
export function createActions(page: Page, options: { preset?: PacePreset; signal?: AbortSignal; checkpoint?: () => Promise<void>; random?: () => number } = {}): Actions {
  let pace = resolvePace(options.preset);
  let pointer = { x: 0, y: 0 };
  const timing = (base: number, jitter: number) => { const sample = options.random?.() ?? Math.random(); if (!Number.isFinite(sample) || sample < 0 || sample > 1) throw new Error('Random source must return a value between zero and one'); return Math.max(0, Math.round(base + (sample * 2 - 1) * jitter)); };
  const checkpoint = async () => { options.signal?.throwIfAborted(); await options.checkpoint?.(); options.signal?.throwIfAborted(); };
  const before = async () => { await checkpoint(); const pause = timing(pace.actionDelayMs, pace.actionJitterMs); if (pause) await delay(pause, undefined, { signal: options.signal }); await checkpoint(); };
  const typeText = async (selector: string, text: string) => {
    await page.waitForSelector(selector, { visible: true });
    await page.focus(selector);
    if (pace.typingDelayMs === 0 && pace.typingJitterMs === 0) { await checkpoint(); await page.keyboard.type(text, { delay: 0 }); await checkpoint(); return; }
    for (const character of text) { await checkpoint(); await page.keyboard.type(character, { delay: timing(pace.typingDelayMs, pace.typingJitterMs) }); }
  };
  const moveTo = async (selector: string) => {
    await page.waitForSelector(selector, { visible: true }); const element = await page.$(selector);
    if (!element) throw new Error('Pointer target was removed');
    try {
      await element.scrollIntoView(); const box = await element.boundingBox(); if (!box) throw new Error('Pointer target is not visible');
      const target = { x: box.x + box.width / 2, y: box.y + box.height / 2 }; const origin = { ...pointer };
      for (let step = 1; step <= pace.pointerSteps; step++) {
        await checkpoint(); const ratio = step / pace.pointerSteps; const eased = ratio * ratio * (3 - 2 * ratio);
        await page.mouse.move(origin.x + (target.x - origin.x) * eased, origin.y + (target.y - origin.y) * eased);
        if (pace.pointerDurationMs) await delay(pace.pointerDurationMs / pace.pointerSteps, undefined, { signal: options.signal });
      }
      pointer = target;
    } finally { await element.dispose(); }
  };
  return {
    checkpoint, setPace: preset => { pace = resolvePace(preset); },
    async moveTo(selector) { await before(); await moveTo(selector); },
    async goto(url) { await before(); await page.goto(url, { waitUntil: 'domcontentloaded' }); },
    async click(selector) { await before(); await page.waitForSelector(selector, { visible: true }); if (pace.pointerDurationMs || pace.pointerSteps > 1) await moveTo(selector); await checkpoint(); await page.click(selector, { delay: pace.clickDelayMs }); },
    async fill(selector, text) {
      await before(); await page.waitForSelector(selector, { visible: true }); await page.focus(selector);
      await page.$eval(selector, element => {
        if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) throw new Error('fill requires an input or textarea');
        const setter = Object.getOwnPropertyDescriptor(element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')?.set;
        setter?.call(element, ''); element.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await typeText(selector, text);
    },
    async type(selector, text) { await before(); await typeText(selector, text); },
    async press(key) { await before(); await page.keyboard.press(key); },
    async waitFor(selector) { await checkpoint(); await page.waitForSelector(selector, { visible: true }); await checkpoint(); },
  };
}
