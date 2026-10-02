import type { Page } from "puppeteer-core";
import type {
  InteractionTrace,
  Recorder,
  RecorderOptions,
  TraceAssertions,
  TraceEvent,
} from "./types.js";
import { validateTrace } from "./calibration.js";

/** Only explicitly marked, nonsensitive fields in an owned synthetic fixture are recorded. */
export async function installInteractionRecorder(
  page: Page,
  options: RecorderOptions,
): Promise<Recorder> {
  const { allowedOrigins, maxEvents = 10_000, ...metadata } = options;
  if (
    !Number.isInteger(maxEvents) ||
    maxEvents < 1 ||
    maxEvents > 100_000 ||
    !allowedOrigins.includes(new URL(page.url()).origin)
  )
    throw new Error("Recorder origin or limit is invalid");
  const base: InteractionTrace = {
    schemaVersion: 1,
    ...metadata,
    events: [],
    assertions: {
      correctValue: false,
      correctFocus: false,
      noDuplicateSubmit: false,
      noSecretCapture: false,
      keysReleased: false,
    },
  };
  validateTrace(base);
  const doc = await page.evaluateHandle(() => document);
  const key = `__workbenchRecorder_${Math.random().toString(36).slice(2)}`;
  await page.evaluate(
    (name, limit) => {
      const events: {
        atMs: number;
        kind: string;
        key?: string;
        field?: string;
        x?: number;
        y?: number;
        deltaY?: number;
      }[] = [];
      const start = performance.now();
      let overflow = false;
      const handler = (event: Event) => {
        if (!(event.target instanceof Element)) return;
        const target = event.target.closest(
          '[data-interaction-synthetic="true"]',
        );
        if (
          !target ||
          !/^[a-zA-Z0-9_-]{1,80}$/.test(
            target.getAttribute("data-interaction-field") ?? "",
          )
        )
          return;
        const field = target.getAttribute("data-interaction-field")!;
        const metadata = [
          target.getAttribute("type"),
          target.getAttribute("autocomplete"),
          target.getAttribute("name"),
          target.id,
        ]
          .join(" ")
          .toLowerCase();
        if (
          /password|email|tel|otp|one.time|token|secret|user|account|card|cc-|payment|pin|code/.test(
            metadata,
          )
        )
          return;
        if (events.length >= limit) {
          overflow = true;
          return;
        }
        const atMs = performance.now() - start;
        if (event instanceof KeyboardEvent) {
          if (
            event.repeat ||
            event.target !== target ||
            !(
              target instanceof HTMLTextAreaElement ||
              (target instanceof HTMLInputElement &&
                ["text", "search"].includes(target.type))
            )
          )
            return;
          if (
            /^(?:[ -~]|Backspace|Tab|Enter|Shift|Control|Alt|Meta|ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Home|End|Delete)$/.test(
              event.key,
            )
          )
            events.push({ atMs, kind: event.type, key: event.key, field });
        } else if (
          event instanceof PointerEvent &&
          event.type === "pointermove"
        )
          events.push({
            atMs,
            kind: "pointer",
            x: event.clientX,
            y: event.clientY,
            field,
          });
        else if (event instanceof WheelEvent)
          events.push({ atMs, kind: "scroll", deltaY: event.deltaY, field });
      };
      const kinds = ["keydown", "keyup", "pointermove", "wheel"];
      kinds.forEach((kind) =>
        document.addEventListener(kind, handler, {
          capture: true,
          passive: true,
        }),
      );
      (globalThis as unknown as Record<string, unknown>)[name] = {
        events,
        stop: () => {
          kinds.forEach((kind) =>
            document.removeEventListener(kind, handler, true),
          );
          return { events, overflow };
        },
      };
    },
    key,
    maxEvents,
  );
  let stopped = false;
  return {
    async stop(assertions: TraceAssertions): Promise<InteractionTrace> {
      if (stopped) throw new Error("Recorder has already stopped");
      stopped = true;
      try {
        const result = await page.evaluate(
          (name, originalDocument) => {
            if (document !== originalDocument)
              throw new Error("Recorder document changed");
            const state = (
              globalThis as unknown as Record<
                string,
                { stop(): { events: TraceEvent[]; overflow: boolean } }
              >
            )[name];
            if (!state) throw new Error("Recorder not found");
            const result = state.stop();
            delete (globalThis as unknown as Record<string, unknown>)[name];
            return result;
          },
          key,
          doc,
        );
        if (result.overflow)
          throw new Error("Recorder event limit exceeded; trace is incomplete");
        const trace = { ...base, events: result.events, assertions };
        validateTrace(trace);
        return trace;
      } finally {
        await doc.dispose();
      }
    },
  };
}
