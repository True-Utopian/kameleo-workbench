import { createHash } from "node:crypto";
import type { Page } from "puppeteer-core";
import type { PacePreset } from "../actions.js";
import {
  createSynthesizedActions,
  InteractionError,
} from "../interaction/executor.js";
import { createPageObserver } from "./recognition.js";
import type {
  ChoiceOption,
  ChoiceSource,
  CompiledFlow,
  FlowDriver,
} from "./types.js";

export class FlowActionError extends Error {
  constructor(
    public readonly code: string,
    public readonly dispatched = false,
  ) {
    super(code);
    this.name = "FlowActionError";
  }
}
export function createPuppeteerFlowDriver(
  page: Page,
  compiled: CompiledFlow,
  options: {
    seed?: string;
    preset?: PacePreset;
    signal?: AbortSignal;
    checkpoint?: () => Promise<void>;
  } = {},
): FlowDriver {
  const observer = createPageObserver(page, compiled);
  let currentGuard: (() => Promise<void>) | undefined;
  let currentSignal: AbortSignal | undefined;
  let busy = false;
  const actions = createSynthesizedActions(page, {
    seed: options.seed || compiled.hash,
    allowedOrigins: Object.values(compiled.manifest.origins),
    preset: options.preset || "fast",
    signal: options.signal,
    checkpoint: async () => {
      currentSignal?.throwIfAborted();
      await options.checkpoint?.();
      currentSignal?.throwIfAborted();
    },
    fieldPolicy: () => "sensitive",
    corrections: false,
    beforeDispatch: async () => {
      currentSignal?.throwIfAborted();
      await currentGuard?.();
      currentSignal?.throwIfAborted();
    },
  });
  const selector = (id: string) => {
    const target = compiled.pack.registry.targets[id];
    if (!target || target.cardinality !== "one")
      throw new FlowActionError("invalid-target");
    return target.selector;
  };
  const guarded = async <T>(
    guard: (() => Promise<void>) | undefined,
    fn: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> => {
    if (busy) throw new FlowActionError("concurrent-dispatch");
    busy = true;
    currentGuard = guard;
    currentSignal = signal;
    try {
      await guard?.();
      return await fn();
    } catch (error) {
      if (error instanceof InteractionError)
        throw new FlowActionError(error.code, error.dispatched);
      throw error;
    } finally {
      currentGuard = undefined;
      currentSignal = undefined;
      busy = false;
    }
  };
  const choices = async (source: ChoiceSource): Promise<ChoiceOption[]> => {
    const raw = await page.evaluate(
      ({ container, source }) => {
        const containers = document.querySelectorAll(container);
        if (containers.length !== 1) return null;
        const visible = (n: Element) => {
          const s = getComputedStyle(n);
          const r = n.getBoundingClientRect();
          return (
            s.display !== "none" &&
            s.visibility === "visible" &&
            Number(s.opacity) !== 0 &&
            r.width > 0 &&
            r.height > 0
          );
        };
        const nodes = Array.from(
          containers[0]!.querySelectorAll(source.optionSelector),
        );
        if (nodes.length > source.maxOptions) return null;
        return nodes.map((n) => ({
          key: n.getAttribute(source.keyAttribute),
          label: n.getAttribute(source.labelAttribute),
          visible: visible(n),
          enabled:
            !n.matches(":disabled") &&
            n.getAttribute("aria-disabled") !== "true" &&
            !n.closest("[inert]"),
          attributes: Object.fromEntries(
            source.patterns
              .flatMap((p) => p.availableWhen)
              .map((c) => [c.attribute, n.getAttribute(c.attribute)]),
          ),
        }));
      },
      { container: selector(source.container), source },
    );
    if (!raw) throw new FlowActionError("invalid-choice-container");
    const keys = new Set<string>();
    const output: ChoiceOption[] = [];
    for (const item of raw) {
      if (
        !item.key ||
        item.key.length > 100 ||
        !item.label ||
        item.label.length > 200 ||
        /[\u0000-\u001f\u007f]/.test(item.label) ||
        keys.has(item.key)
      )
        throw new FlowActionError("invalid-choice-identity");
      keys.add(item.key);
      const patterns = source.patterns.filter((p) =>
        p.match.keyEquals !== undefined
          ? p.match.keyEquals === item.key
          : new RegExp(p.match.keyPattern).test(item.key!),
      );
      const pattern = patterns.length === 1 ? patterns[0] : undefined;
      const available =
        !!pattern &&
        pattern.supported &&
        item.visible &&
        item.enabled &&
        pattern.availableWhen.every(
          (c) => item.attributes[c.attribute] === c.equals,
        );
      const type = pattern?.type || "unsupported";
      output.push({
        key: item.key,
        label: item.label,
        type,
        available,
        reason: available
          ? undefined
          : pattern?.unavailableReason || "Unsupported or ambiguous option",
        identity: createHash("sha256")
          .update(JSON.stringify([item.key, item.label, type]))
          .digest("hex"),
      });
    }
    return output;
  };
  return {
    observe: observer.observe,
    dispose: observer.dispose,
    navigate: (url, guard, signal) =>
      guarded(guard, () => actions.goto(url), signal),
    fill: (id, value, guard, signal) =>
      guarded(guard, () => actions.fill(selector(id), value), signal),
    click: (id, guard, signal) =>
      guarded(guard, () => actions.click(selector(id)), signal),
    async scrape(operation, guard, signal) {
      return guarded(
        guard,
        async () => {
          const value = await page.evaluate(
            ({ selector, read, maxLength }) => {
              const nodes = document.querySelectorAll(selector);
              if (nodes.length !== 1) return null;
              const value =
                read.kind === "text"
                  ? nodes[0]!.textContent
                  : nodes[0]!.getAttribute(read.name);
              return typeof value === "string" && value.length <= maxLength
                ? value
                : null;
            },
            {
              selector: selector(operation.target),
              read: operation.read,
              maxLength: operation.maxLength,
            },
          );
          if (value === null) throw new FlowActionError("invalid-scrape");
          await guard();
          return value;
        },
        signal,
      );
    },
    choices,
    async choose(source, selected, guard, signal) {
      const fresh = await choices(source);
      const option = fresh.find((o) => o.key === selected.key);
      if (!option?.available || option.identity !== selected.identity)
        throw new FlowActionError("stale-choice");
      const escaped = [...selected.key]
        .map((character) => `\\${character.codePointAt(0)!.toString(16)} `)
        .join("");
      const optionSelector = `:is(${selector(source.container)}) :is(${source.optionSelector})[${source.keyAttribute}="${escaped}"]`;
      await guarded(
        async () => {
          await guard();
          const options = await choices(source);
          if (
            !options.some(
              (o) =>
                o.key === selected.key &&
                o.identity === selected.identity &&
                o.available,
            )
          )
            throw new FlowActionError("stale-choice");
        },
        () => actions.click(optionSelector),
        signal,
      );
    },
  };
}
