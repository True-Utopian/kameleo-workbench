import { test } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "puppeteer-core";
import {
  calibrateInteraction,
  createSynthesizedActions,
  DEFAULT_INTERACTION_MODEL,
  InteractionError,
  planPointer,
  planScroll,
  planTyping,
  scoreInteraction,
  validateModel,
  validateTrace,
} from "../src/interaction/index.js";
import type {
  InteractionModel,
  InteractionTrace,
  TraceEvent,
} from "../src/interaction/index.js";

test("seeded joint timing preserves down order, signed flight and repeated-key release", () => {
  const model = structuredClone(DEFAULT_INTERACTION_MODEL);
  model.global.mean = [Math.log(180), Math.log(45)];
  const plan = planTyping("abaca aababa", {
    seed: "stable",
    model,
    rollover: true,
  });
  assert.deepEqual(
    plan,
    planTyping("abaca aababa", { seed: "stable", model, rollover: true }),
  );
  const held = new Set<string>();
  let previousDown = -1,
    overlaps = 0;
  for (const event of plan.events) {
    if (event.kind === "down") {
      assert.ok(event.atMs > previousDown);
      assert.ok(!held.has(event.key));
      if (held.size) overlaps++;
      held.add(event.key);
      previousDown = event.atMs;
    } else if (event.kind === "up") {
      assert.ok(held.has(event.key));
      held.delete(event.key);
    }
  }
  assert.ok(overlaps > 0);
  assert.equal(held.size, 0);
  const sequential = planTyping("abababa", {
    seed: "stable",
    model,
    rollover: false,
  });
  assert.equal(
    sequential.events.map((event) => event.kind).join(","),
    Array.from({ length: 7 }, () => "down,up").join(","),
  );
});

test("corrections require explicit synthetic field policy and preserve intended text", () => {
  const corrected = planTyping("sample words", {
    seed: "correction",
    fieldPolicy: "synthetic-free-text",
    corrections: true,
    correctionProbability: 1,
  });
  let text = "";
  for (const event of corrected.events)
    if (event.kind === "down" || event.kind === "insert")
      text = event.key === "Backspace" ? text.slice(0, -1) : text + event.key;
  assert.equal(corrected.corrections, 1);
  assert.equal(text, "sample words");
  for (const fieldPolicy of ["sensitive", "ordinary"] as const)
    assert.equal(
      planTyping("sample words", {
        seed: "same",
        fieldPolicy,
        corrections: true,
        correctionProbability: 1,
      }).corrections,
      0,
    );
  const secret = planTyping("123456", {
    seed: "otp",
    fieldPolicy: "sensitive",
    corrections: true,
    fatigue: true,
    activeTypingMs: 3_600_000,
  });
  assert.ok(secret.events.every((event) => event.kind === "insert"));
  assert.ok(secret.durationMs < 10);
});

test("fatigue stays bounded and pointer/scroll plans terminate exactly and reproducibly", () => {
  const plain = planTyping("abababab", { seed: "fatigue" });
  const tired = planTyping("abababab", {
    seed: "fatigue",
    fatigue: true,
    activeTypingMs: 3_600_000,
  });
  assert.ok(tired.durationMs >= plain.durationMs);
  assert.ok(tired.durationMs <= plain.durationMs * 1.3);
  const box = { x: 100, y: 100, width: 30, height: 30 },
    path = planPointer({ x: 0, y: 0 }, box, "path");
  assert.deepEqual(path, planPointer({ x: 0, y: 0 }, box, "path"));
  assert.equal(path.at(-1)!.x, 115);
  assert.equal(path.at(-1)!.y, 115);
  assert.ok(
    path.every(
      (point, i) =>
        Number.isFinite(point.x) &&
        Number.isFinite(point.y) &&
        (!i || point.atMs > path[i - 1]!.atMs),
    ),
  );
  for (const delta of [-500, 700])
    assert.ok(
      Math.abs(
        planScroll(delta, "scroll").reduce(
          (sum, item) => sum + item.deltaY,
          0,
        ) - delta,
      ) < 1e-9,
    );
  assert.throws(() => planScroll(Infinity, "bad"));
  assert.throws(() =>
    planPointer({ x: 0, y: 0 }, { ...box, width: -1 }, "bad"),
  );
});

function trace(
  id: string,
  participant: string,
  source: "human" | "synthetic",
  split: InteractionTrace["split"],
): InteractionTrace {
  let down = 0;
  const events: TraceEvent[] = [];
  for (let i = 0; i < 18; i++) {
    const key = i % 2 ? "b" : "a",
      dwell = 55 + ((i * 7) % 37),
      interval = 120 + ((i * 13) % 51);
    events.push(
      { atMs: down, kind: "keydown", key, field: "fixture" },
      { atMs: down + dwell, kind: "keyup", key, field: "fixture" },
    );
    down += interval;
  }
  events.sort((a, b) => a.atMs - b.atMs);
  return {
    schemaVersion: 1,
    source,
    split,
    consent: { granted: true, purpose: "owned-site-synthetic-testing" },
    syntheticTask: true,
    participantId: participant,
    sessionId: id,
    taskId: "typing",
    deviceClass: "desktop",
    keyboardLayout: "ascii",
    events,
    assertions: {
      correctValue: true,
      correctFocus: true,
      noDuplicateSubmit: true,
      noSecretCapture: true,
      keysReleased: true,
    },
  };
}

test("calibration fits bounded digraph groups and refuses holdout/nonconsented training", () => {
  const training = [
      trace("train1", "train-person", "human", "train"),
      trace("train2", "train-person", "human", "train"),
    ],
    model = calibrateInteraction(training);
  validateModel(model);
  assert.ok(model.calibrated);
  assert.ok(Object.keys(model.digraphs).length >= 2);
  assert.equal(model.trainingParticipants.length, 1);
  assert.throws(() =>
    calibrateInteraction([trace("holdout", "other", "human", "holdout")]),
  );
  assert.throws(() =>
    validateTrace({
      ...training[0]!,
      consent: { granted: false },
    } as unknown as InteractionTrace),
  );
  assert.throws(() =>
    validateModel({
      ...model,
      global: { count: 1, mean: [1, 1], covariance: [1, 2, 1] },
    }),
  );
});

test("heldout scoring enforces leakage, correctness, coverage and observed distribution thresholds", () => {
  const model = calibrateInteraction([
    trace("train", "training-only", "human", "train"),
  ]);
  const human = [
    trace("h1", "p1", "human", "holdout"),
    trace("h2", "p1", "human", "holdout"),
    trace("h3", "p2", "human", "holdout"),
    trace("h4", "p2", "human", "holdout"),
  ];
  const synthetic = [
    trace("s1", "machine", "synthetic", "holdout"),
    trace("s2", "machine", "synthetic", "holdout"),
  ];
  const options = { bootstrapSamples: 20, minimumParticipants: 2 };
  const identical = scoreInteraction(model, human, synthetic, options);
  assert.equal(identical.estimate.score, 100);
  assert.equal(identical.passed, true);
  const limited = scoreInteraction(model, human, synthetic, {
    bootstrapSamples: 20,
  });
  assert.ok(
    limited.reasons.includes("insufficient_participant_session_coverage"),
  );
  const wrong = structuredClone(synthetic);
  wrong[0]!.assertions.correctValue = false;
  assert.equal(scoreInteraction(model, human, wrong, options).passed, false);
  const slower = structuredClone(synthetic);
  for (const item of slower) for (const event of item.events) event.atMs *= 3;
  assert.equal(scoreInteraction(model, human, slower, options).passed, false);
  assert.throws(() =>
    scoreInteraction(
      model,
      [trace("new", "training-only", "human", "holdout")],
      synthetic,
      options,
    ),
  );
  const incomplete = scoreInteraction(model, human, synthetic, {
    ...options,
    metrics: ["pointerSpeed"],
  });
  assert.ok(
    incomplete.reasons.includes("missing_or_degenerate_required_features"),
  );
});

function browserMock() {
  const state = {
    text: "old",
    focused: false,
    sameDocument: true,
    downs: [] as string[],
    ups: [] as string[],
    clicks: 0,
    selected: false,
    sensitive: false,
    synthetic: false,
    onDown: undefined as ((key: string) => void) | undefined,
  };
  const held = new Set<string>(),
    documentHandle = { dispose: async () => {} };
  const element = {
    dispose: async () => {},
    scrollIntoView: async () => {},
    boundingBox: async () => ({ x: 10, y: 10, width: 100, height: 30 }),
    evaluate: async (_fn: unknown, ...args: unknown[]) => {
      if (args.length === 4)
        return state.sameDocument && (!args[2] || state.focused);
      if (args.length === 1) return state.text === args[0];
      return {
        sensitive: state.sensitive,
        synthetic: state.synthetic,
        textType: true,
        initial: state.text,
        mac: false,
      };
    },
  };
  const page = {
    url: () => "https://owned.test/form",
    waitForSelector: async () => element,
    $$: async () => [element],
    evaluateHandle: async () => documentHandle,
    mouse: {
      move: async () => {},
      down: async () => {
        state.clicks++;
      },
      up: async () => {
        state.focused = true;
      },
      wheel: async () => {},
    },
    keyboard: {
      down: async (key: string) => {
        state.downs.push(key);
        held.add(key);
        if (key === "KeyA" && held.has("Control")) state.selected = true;
        else if (key === "Backspace") {
          state.text = state.selected ? "" : state.text.slice(0, -1);
          state.selected = false;
        } else if (key.length === 1 && !held.has("Control")) state.text += key;
        state.onDown?.(key);
      },
      up: async (key: string) => {
        state.ups.push(key);
        held.delete(key);
      },
      press: async () => {},
      sendCharacter: async (text: string) => {
        state.text += text;
      },
    },
  } as unknown as Page;
  return { state, page, held };
}

test("executor fill verifies exact value; sensitive metadata suppresses corrections", async () => {
  const { state, page, held } = browserMock();
  state.sensitive = true;
  state.synthetic = true;
  const actions = createSynthesizedActions(page, {
    seed: "fill",
    allowedOrigins: ["https://owned.test"],
    preset: "fast",
    corrections: true,
    fieldPolicy: () => "synthetic-free-text",
  });
  await actions.fill("input", "secret123");
  assert.equal(state.text, "secret123");
  assert.equal(held.size, 0);
  assert.equal(state.downs.filter((key) => key === "Backspace").length, 1);
});

test("executor releases held keys and stops typing after focus/document loss", async () => {
  const { state, page, held } = browserMock();
  state.onDown = (key) => {
    if (key === "a") state.sameDocument = false;
  };
  const actions = createSynthesizedActions(page, {
    seed: "guard",
    allowedOrigins: ["https://owned.test"],
    preset: "fast",
  });
  await assert.rejects(
    actions.fill("input", "abc"),
    (error: unknown) => error instanceof InteractionError && error.dispatched,
  );
  assert.equal(state.text, "a");
  assert.equal(held.size, 0);
  assert.ok(state.ups.includes("a"));
});

test("abort and beforeDispatch refusal prevent effects; interrupted instance stays blocked", async () => {
  const { state, page } = browserMock(),
    controller = new AbortController();
  controller.abort();
  const aborted = createSynthesizedActions(page, {
    seed: "abort",
    allowedOrigins: ["https://owned.test"],
    signal: controller.signal,
  });
  await assert.rejects(aborted.click("button"));
  assert.equal(state.clicks, 0);
  const guarded = createSynthesizedActions(page, {
    seed: "refuse",
    allowedOrigins: ["https://owned.test"],
    beforeDispatch: async () => {
      throw new Error("sensitive details must not leak");
    },
  });
  await assert.rejects(
    guarded.click("button"),
    (error: unknown) =>
      error instanceof InteractionError &&
      error.code === "guard_rejected" &&
      !error.dispatched &&
      !error.message.includes("sensitive details"),
  );
  assert.equal(state.clicks, 0);
});

test("append rechecks focus after the final dispatch hook before keyboard modifiers", async () => {
  const { state, page, held } = browserMock();
  const actions = createSynthesizedActions(page, {
    seed: "append-guard",
    allowedOrigins: ["https://owned.test"],
    preset: "fast",
    beforeDispatch: async ({ kind }) => {
      if (kind === "key") state.focused = false;
    },
  });
  await assert.rejects(
    actions.type("input", "abc"),
    (error: unknown) =>
      error instanceof InteractionError && error.code === "guard_rejected",
  );
  assert.equal(state.text, "old");
  assert.deepEqual(state.downs, []);
  assert.equal(held.size, 0);
});

test("timed out browser dispatch quarantines the adapter and late completion sends no more input", async () => {
  const { state, page } = browserMock();
  let resolveDown: (() => void) | undefined;
  page.mouse.down = async () => {
    state.clicks++;
    await new Promise<void>((resolve) => {
      resolveDown = resolve;
    });
  };
  const actions = createSynthesizedActions(page, {
    seed: "timeout",
    allowedOrigins: ["https://owned.test"],
    preset: "fast",
    timeoutMs: 30,
  });
  await assert.rejects(
    actions.click("button"),
    (error: unknown) => error instanceof InteractionError && error.dispatched,
  );
  await assert.rejects(
    actions.click("button"),
    (error: unknown) =>
      error instanceof InteractionError && error.code === "uncertain",
  );
  resolveDown?.();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(state.clicks, 1);
  assert.equal(state.downs.length, 0);
});
