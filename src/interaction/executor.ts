import type { ElementHandle, JSHandle, Page } from "puppeteer-core";
import { setTimeout as delay } from "node:timers/promises";
import { resolvePace } from "../actions.js";
import { DEFAULT_INTERACTION_MODEL, validateModel } from "./model.js";
import { planPointer, planScroll, planTyping } from "./planner.js";
import type {
  FieldPolicy,
  InteractionModel,
  Point,
  SynthesizedActionOptions,
  SynthesizedActions,
} from "./types.js";

export class InteractionError extends Error {
  constructor(
    public readonly code:
      | "guard_rejected"
      | "interrupted"
      | "uncertain"
      | "postcondition_failed",
    public readonly dispatched: boolean,
  ) {
    super(`Interaction ${code}; dispatched=${dispatched}`);
    this.name = "InteractionError";
  }
}
interface Target {
  element: ElementHandle<Element>;
  document: JSHandle<Document>;
  href: string;
  selector: string;
}
export function createSynthesizedActions(
  page: Page,
  options: SynthesizedActionOptions,
): SynthesizedActions {
  const origins = new Set(
    options.allowedOrigins.map((value) => {
      const url = new URL(value);
      if (!["http:", "https:"].includes(url.protocol) || url.origin !== value)
        throw new Error("Use exact HTTP(S) allowed origins");
      return value;
    }),
  );
  if (!origins.size)
    throw new Error("At least one owned-site origin is required");
  let model = options.model ?? DEFAULT_INTERACTION_MODEL;
  validateModel(model);
  let fast = options.preset === "fast",
    scale = 1,
    pointer: Point = { x: 0, y: 0 },
    counter = 0,
    activeTypingMs = 0,
    blocked = false;
  let queue: Promise<unknown> = Promise.resolve();
  const held = new Set<string>();
  let buttonHeld = false;
  const allowed = (href: string) => {
    try {
      return origins.has(new URL(href).origin);
    } catch {
      return false;
    }
  };
  const setPace: SynthesizedActions["setPace"] = (preset) => {
    const pace = resolvePace(preset);
    fast = preset === "fast" || pace.typingDelayMs === 0;
    scale = fast ? 0 : Math.max(0.1, pace.typingDelayMs / 80);
  };
  if (options.preset) setPace(options.preset);
  const cleanup = async () => {
    const releases = [...held].map(async (key) => {
      try {
        await page.keyboard.up(key as Parameters<Page["keyboard"]["up"]>[0]);
      } catch {
        /* Owner must reconcile uncertain cleanup. */
      }
    });
    held.clear();
    if (buttonHeld) {
      releases.push(page.mouse.up().catch(() => undefined));
      buttonHeld = false;
    }
    const timer = new AbortController();
    try {
      await Promise.race([
        Promise.all(releases),
        delay(500, undefined, { signal: timer.signal }),
      ]);
    } finally {
      timer.abort();
    }
  };
  const run = <T>(
    fn: (context: {
      signal: AbortSignal;
      checkpoint: () => Promise<void>;
      wait: (ms: number) => Promise<void>;
      effect: (
        kind: Parameters<
          NonNullable<SynthesizedActionOptions["beforeDispatch"]>
        >[0]["kind"],
        selector: string | undefined,
        fn: () => Promise<void>,
      ) => Promise<void>;
      guard: (target: Target, focus?: boolean, hit?: Point) => Promise<void>;
      dispatched: () => boolean;
    }) => Promise<T>,
  ): Promise<T> => {
    const operation = queue.then(async () => {
      if (blocked) throw new InteractionError("uncertain", false);
      const controller = new AbortController(),
        timeout = options.timeoutMs ?? 30_000;
      if (!Number.isFinite(timeout) || timeout < 1 || timeout > 600_000)
        throw new Error("Invalid interaction timeout");
      const timer = setTimeout(() => controller.abort(), timeout);
      const signal = options.signal
        ? AbortSignal.any([controller.signal, options.signal])
        : controller.signal;
      let dispatched = false;
      const bounded = async <R>(promise: Promise<R>): Promise<R> => {
        signal.throwIfAborted();
        let onAbort: (() => void) | undefined;
        try {
          return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
              onAbort = () =>
                reject(new InteractionError("interrupted", dispatched));
              signal.addEventListener("abort", onAbort, { once: true });
            }),
          ]);
        } finally {
          if (onAbort) signal.removeEventListener("abort", onAbort);
        }
      };
      const checkpoint = async () => {
        signal.throwIfAborted();
        if (options.checkpoint) await bounded(options.checkpoint());
        signal.throwIfAborted();
      };
      const wait = async (ms: number) => {
        await checkpoint();
        if (ms > 0) await delay(ms, undefined, { signal });
        await checkpoint();
      };
      const effect = async (
        kind: Parameters<
          NonNullable<SynthesizedActionOptions["beforeDispatch"]>
        >[0]["kind"],
        selector: string | undefined,
        dispatch: () => Promise<void>,
      ) => {
        await checkpoint();
        if (options.beforeDispatch) {
          try {
            await bounded(options.beforeDispatch({ kind, selector }));
          } catch {
            throw new InteractionError("guard_rejected", dispatched);
          }
        }
        signal.throwIfAborted();
        dispatched = true;
        await bounded(dispatch());
        signal.throwIfAborted();
      };
      const guard = async (target: Target, focus = false, hit?: Point) => {
        await checkpoint();
        let valid = false;
        try {
          valid = await bounded(
            target.element.evaluate(
              (element, documentHandle, href, requireFocus, point) => {
                if (
                  document !== documentHandle ||
                  location.href !== href ||
                  !element.isConnected ||
                  element.ownerDocument !== document
                )
                  return false;
                const style = getComputedStyle(element),
                  box = element.getBoundingClientRect();
                if (
                  style.display === "none" ||
                  style.visibility !== "visible" ||
                  Number(style.opacity) === 0 ||
                  !box.width ||
                  !box.height ||
                  element.closest('[inert],[aria-hidden="true"]') ||
                  ("disabled" in element && element.disabled) ||
                  element.getAttribute("aria-disabled") === "true"
                )
                  return false;
                if (requireFocus && document.activeElement !== element)
                  return false;
                if (point) {
                  const top = document.elementFromPoint(point.x, point.y);
                  if (!top || !(top === element || element.contains(top)))
                    return false;
                }
                return true;
              },
              target.document,
              target.href,
              focus,
              hit,
            ),
          );
        } catch {
          /* Navigation detaches old handles. */
        }
        if (!valid || !allowed(target.href))
          throw new InteractionError("guard_rejected", dispatched);
      };
      try {
        await checkpoint();
        return await bounded(
          fn({
            signal,
            checkpoint,
            wait,
            effect,
            guard,
            dispatched: () => dispatched,
          }),
        );
      } catch (error) {
        if (
          signal.aborted ||
          (dispatched && !(error instanceof InteractionError))
        )
          blocked = true;
        if (error instanceof InteractionError) throw error;
        throw new InteractionError(
          signal.aborted ? "interrupted" : "uncertain",
          dispatched,
        );
      } finally {
        clearTimeout(timer);
        await cleanup();
      }
    });
    queue = operation.catch(() => undefined);
    return operation;
  };
  type Context = Parameters<Parameters<typeof run>[0]>[0];
  const target = async (selector: string): Promise<Target> => {
    if (
      typeof selector !== "string" ||
      !selector.length ||
      selector.length > 512 ||
      !allowed(page.url())
    )
      throw new InteractionError("guard_rejected", false);
    await page.waitForSelector(selector, {
      visible: true,
      timeout: options.timeoutMs ?? 30_000,
    });
    const elements = await page.$$(selector);
    if (elements.length !== 1) {
      await Promise.all(elements.map((element) => element.dispose()));
      throw new InteractionError("guard_rejected", false);
    }
    try {
      return {
        element: elements[0]!,
        document: await page.evaluateHandle(() => document),
        href: page.url(),
        selector,
      };
    } catch (error) {
      await elements[0]!.dispose();
      throw error;
    }
  };
  const dispose = async (value: Target) => {
    await Promise.allSettled([
      value.element.dispose(),
      value.document.dispose(),
    ]);
  };
  const move = async (value: Target, context: Context) => {
    await context.guard(value);
    // Geometry acquisition is explicit; wheel behavior is exercised by scroll().
    await context.effect("scroll", value.selector, async () => {
      await context.guard(value);
      await value.element.scrollIntoView();
    });
    await context.guard(value);
    const box = await value.element.boundingBox();
    if (!box)
      throw new InteractionError("guard_rejected", context.dispatched());
    const path = fast
      ? [{ atMs: 0, x: box.x + box.width / 2, y: box.y + box.height / 2 }]
      : planPointer(pointer, box, `${options.seed}:${counter++}`);
    let previous = 0;
    for (const sample of path) {
      await context.wait((sample.atMs - previous) * scale);
      await context.guard(value);
      await context.effect("pointer", value.selector, async () => {
        await context.guard(value);
        await page.mouse.move(sample.x, sample.y);
      });
      pointer = sample;
      previous = sample.atMs;
    }
    await context.guard(value, false, pointer);
  };
  const click = async (value: Target, context: Context) => {
    await move(value, context);
    await context.guard(value, false, pointer);
    await context.effect("click", value.selector, async () => {
      await context.guard(value, false, pointer);
      buttonHeld = true;
      await page.mouse.down();
    });
    await context.wait(fast ? 0 : 40 * scale);
    // Always release at current position; a new page must not receive another press.
    await context.effect("click", value.selector, async () => {
      await page.mouse.up();
      buttonHeld = false;
    });
  };
  const type = async (
    selector: string,
    text: string,
    clear: boolean,
    context: Context,
  ) => {
    if (typeof text !== "string" || text.length > 10_000)
      throw new InteractionError("guard_rejected", false);
    const value = await target(selector);
    try {
      await click(value, context);
      await context.guard(value, true);
      const info = await value.element.evaluate((element) => {
        if (
          !(
            element instanceof HTMLInputElement ||
            element instanceof HTMLTextAreaElement
          ) ||
          element.readOnly
        )
          return null;
        const metadata = [
          element.getAttribute("type"),
          element.getAttribute("autocomplete"),
          element.getAttribute("name"),
          element.id,
        ]
          .join(" ")
          .toLowerCase();
        return {
          sensitive:
            /password|email|tel|otp|one.time|token|secret|user|account|card|cc-|payment|pin|code/.test(
              metadata,
            ),
          synthetic:
            element.getAttribute("data-interaction-synthetic") === "true",
          textType:
            element instanceof HTMLTextAreaElement ||
            ["text", "search"].includes(element.type),
          initial: element.value,
          mac: /mac/i.test(navigator.platform),
        };
      });
      if (!info)
        throw new InteractionError("guard_rejected", context.dispatched());
      const requested = options.fieldPolicy?.(selector) ?? "ordinary";
      const policy: FieldPolicy =
        info.sensitive || requested === "sensitive"
          ? "sensitive"
          : requested === "synthetic-free-text" &&
              info.synthetic &&
              info.textType
            ? "synthetic-free-text"
            : "ordinary";
      if (clear) {
        const modifier = info.mac ? "Meta" : "Control";
        for (const [kind, key] of [
          ["down", modifier],
          ["down", "KeyA"],
          ["up", "KeyA"],
          ["up", modifier],
          ["down", "Backspace"],
          ["up", "Backspace"],
        ] as const) {
          await context.guard(value, true);
          await context.effect("clear", selector, async () => {
            await context.guard(value, true);
            if (kind === "down") {
              held.add(key);
              await page.keyboard.down(key);
            } else {
              await page.keyboard.up(key);
              held.delete(key);
            }
          });
        }
      } else {
        // type() appends predictably rather than relying on a click's caret position.
        const modifier = info.mac ? "Meta" : "Control";
        await context.guard(value, true);
        await context.effect("key", selector, async () => {
          await context.guard(value, true);
          held.add(modifier);
          await page.keyboard.down(modifier);
        });
        await context.guard(value, true);
        await context.effect("key", selector, async () => {
          await context.guard(value, true);
          await page.keyboard.press(info.mac ? "ArrowDown" : "End");
        });
        await context.guard(value, true);
        await context.effect("key", selector, async () => {
          await context.guard(value, true);
          await page.keyboard.up(modifier);
          held.delete(modifier);
        });
      }
      const plan = planTyping(text, {
        seed: `${options.seed}:${counter++}`,
        model,
        fieldPolicy: policy,
        corrections: options.corrections,
        rollover: options.rollover,
        fatigue: options.fatigue,
        activeTypingMs,
      });
      let previous = 0;
      for (const event of plan.events) {
        await context.wait(fast ? 0 : (event.atMs - previous) * scale);
        await context.guard(value, true);
        await context.effect(
          event.kind === "insert" ? "insert" : "key",
          selector,
          async () => {
            await context.guard(value, true);
            if (event.kind === "insert")
              await page.keyboard.sendCharacter(event.key);
            else if (event.kind === "down") {
              held.add(event.key);
              await page.keyboard.down(
                event.key as Parameters<Page["keyboard"]["down"]>[0],
              );
            } else {
              await page.keyboard.up(
                event.key as Parameters<Page["keyboard"]["up"]>[0],
              );
              held.delete(event.key);
            }
          },
        );
        previous = event.atMs;
      }
      activeTypingMs += plan.activeTypingMs;
      await context.guard(value, true);
      const correct = await value.element.evaluate(
        (element, expected) => (element as HTMLInputElement).value === expected,
        (clear ? "" : info.initial) + text,
      );
      if (!correct) throw new InteractionError("postcondition_failed", true);
    } finally {
      await dispose(value);
    }
  };
  return {
    setPace,
    useModel(next: InteractionModel) {
      validateModel(next);
      model = structuredClone(next);
    },
    checkpoint: async () => {
      options.signal?.throwIfAborted();
      await options.checkpoint?.();
      options.signal?.throwIfAborted();
    },
    goto: (url) =>
      run(async (context) => {
        if (!allowed(url)) throw new InteractionError("guard_rejected", false);
        await context.effect("goto", undefined, async () => {
          await page.goto(url, {
            waitUntil: "domcontentloaded",
            timeout: options.timeoutMs ?? 30_000,
          });
        });
        if (!allowed(page.url()))
          throw new InteractionError("guard_rejected", true);
      }),
    click: (selector) =>
      run(async (context) => {
        const value = await target(selector);
        try {
          await click(value, context);
        } finally {
          await dispose(value);
        }
      }),
    focus: (selector) =>
      run(async (context) => {
        const value = await target(selector);
        try {
          await click(value, context);
          await context.guard(value, true);
        } finally {
          await dispose(value);
        }
      }),
    moveTo: (selector) =>
      run(async (context) => {
        const value = await target(selector);
        try {
          await move(value, context);
        } finally {
          await dispose(value);
        }
      }),
    fill: (selector, text) =>
      run((context) => type(selector, text, true, context)),
    type: (selector, text) =>
      run((context) => type(selector, text, false, context)),
    press: (key) =>
      run(async (context) => {
        if (!allowed(page.url()))
          throw new InteractionError("guard_rejected", false);
        await context.effect("key", undefined, () => page.keyboard.press(key));
      }),
    waitFor: (selector) =>
      run(async (context) => {
        const value = await target(selector);
        try {
          await context.guard(value);
        } finally {
          await dispose(value);
        }
      }),
    scroll: (selector, deltaY) =>
      run(async (context) => {
        const value = await target(selector);
        try {
          await move(value, context);
          let previous = 0;
          for (const event of planScroll(
            deltaY,
            `${options.seed}:${counter++}`,
          )) {
            await context.wait(fast ? 0 : event.atMs - previous);
            await context.guard(value, false, pointer);
            await context.effect("scroll", selector, async () => {
              await context.guard(value, false, pointer);
              await page.mouse.wheel({ deltaY: event.deltaY });
            });
            previous = event.atMs;
          }
        } finally {
          await dispose(value);
        }
      }),
  };
}
