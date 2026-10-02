import {
  clamp,
  DEFAULT_INTERACTION_MODEL,
  normal,
  seededRandom,
  timingGroup,
  validateModel,
} from "./model.js";
import type {
  KeyPrimitive,
  Point,
  PointerSample,
  TargetBox,
  TypingOptions,
  TypingPlan,
} from "./types.js";

const physical = (key: string) =>
  /^[a-z0-9 .,;/'\[\]\\=\-]$/.test(key) || key === "Backspace";
export function planTyping(text: string, options: TypingOptions): TypingPlan {
  if (typeof text !== "string" || text.length > 10_000)
    throw new Error("Typing input exceeds the 10000-character limit");
  const model = options.model ?? DEFAULT_INTERACTION_MODEL;
  validateModel(model);
  const random = seededRandom(`${options.seed}:keyboard`),
    mistakes = seededRandom(`${options.seed}:corrections`),
    driftRandom = seededRandom(`${options.seed}:fatigue`);
  const probability = options.correctionProbability ?? 0.006;
  if (!Number.isFinite(probability) || probability < 0 || probability > 1)
    throw new Error("Invalid correction probability");
  const sensitive = options.fieldPolicy === "sensitive";
  const original = [
    ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text),
  ].map((item) => item.segment);
  const correctionAllowed =
    options.corrections &&
    options.fieldPolicy === "synthetic-free-text" &&
    /^[a-z ]*$/.test(text);
  const sequence: { key: string; pause: number }[] = [];
  let corrections = 0;
  for (let i = 0; i < original.length; i++) {
    if (
      correctionAllowed &&
      !corrections &&
      original[i] !== " " &&
      mistakes() < probability
    ) {
      const size = Math.min(mistakes() < 0.8 ? 1 : 2, original.length - i);
      corrections++;
      for (let j = 0; j < size; j++)
        sequence.push({ key: original[i + j] === "x" ? "z" : "x", pause: 0 });
      const recognition = clamp(
        Math.exp(Math.log(450) + 0.4 * normal(mistakes)),
        200,
        1200,
      );
      for (let j = 0; j < size; j++)
        sequence.push({
          key: "Backspace",
          pause: j ? 60 + mistakes() * 90 : recognition,
        });
      for (let j = 0; j < size; j++)
        sequence.push({
          key: original[i + j]!,
          pause: j ? 0 : 100 + mistakes() * 150,
        });
      i += size - 1;
    } else sequence.push({ key: original[i]!, pause: 0 });
  }
  const events: KeyPrimitive[] = [];
  const releases = new Map<string, number>();
  let down = 0,
    priorDown = -1,
    priorUp = 0,
    active = options.activeTypingMs ?? 0,
    constrained = 0,
    noise = 0,
    minute = -1;
  if (!Number.isFinite(active) || active < 0)
    throw new Error("Invalid active typing duration");
  const sessionOffset = normal(random) * 0.15;
  for (let i = 0; i < sequence.length; i++) {
    const current = sequence[i]!,
      next = sequence[i + 1]?.key ?? "";
    const group = timingGroup(model, current.key, next);
    const [v0, cov, v1] = group.covariance;
    const z0 = normal(random),
      z1 = normal(random),
      logH = group.mean[0] + Math.sqrt(v0) * z0 + sessionOffset;
    const logG =
      group.mean[1] +
      (cov / Math.sqrt(v0)) * z0 +
      Math.sqrt(Math.max(0, v1 - (cov * cov) / v0)) * z1 +
      sessionOffset;
    let multiplier = 1;
    if (options.fatigue && !sensitive) {
      const nextMinute = Math.floor(active / 60_000);
      while (minute < Math.min(nextMinute, 1440)) {
        noise =
          0.9 * noise + 0.02 * Math.sqrt(1 - 0.9 ** 2) * normal(driftRandom);
        minute++;
      }
      multiplier = clamp(
        Math.exp(((Math.log(1.2) / 20) * active) / 60_000 + noise),
        1,
        1.25,
      );
    }
    const dwell = sensitive ? 0 : clamp(Math.exp(logH) * multiplier, 35, 220);
    let interval = sensitive ? 1 : clamp(Math.exp(logG) * multiplier, 20, 600);
    if (
      !options.rollover ||
      corrections ||
      !physical(current.key) ||
      !physical(next) ||
      current.key === next
    )
      interval = Math.max(interval, dwell + (sensitive ? 1 : 20));
    if (i && (current.pause || current.key === "Backspace"))
      down = Math.max(down, priorUp) + current.pause;
    const adjusted = Math.max(
      down,
      priorDown + 1,
      (releases.get(current.key) ?? -1) + 1,
    );
    if (adjusted !== down) constrained++;
    down = adjusted;
    if (!sensitive && physical(current.key)) {
      events.push(
        { atMs: down, kind: "down", key: current.key },
        { atMs: down + dwell, kind: "up", key: current.key },
      );
      releases.set(current.key, down + dwell);
    } else events.push({ atMs: down, kind: "insert", key: current.key });
    priorDown = down;
    priorUp = down + dwell;
    down += interval;
    active += interval;
    if (!sensitive && current.key === " " && random() < 0.08)
      down += clamp(Math.exp(Math.log(350) + normal(random) * 0.4), 150, 900);
  }
  events.sort(
    (a, b) =>
      a.atMs - b.atMs || (a.kind === "up" ? -1 : b.kind === "up" ? 1 : 0),
  );
  return {
    events,
    durationMs: events.at(-1)?.atMs ?? 0,
    activeTypingMs: active - (options.activeTypingMs ?? 0),
    corrections,
    constrainedIntervals: constrained,
  };
}

export function planPointer(
  origin: Point,
  box: TargetBox,
  seed: string,
): PointerSample[] {
  if (
    [origin.x, origin.y, box.x, box.y, box.width, box.height].some(
      (n) => !Number.isFinite(n) || Math.abs(n) > 1e6,
    ) ||
    box.width <= 0 ||
    box.height <= 0
  )
    throw new Error("Invalid pointer geometry");
  const random = seededRandom(`${seed}:pointer`),
    target = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const dx = target.x - origin.x,
    dy = target.y - origin.y,
    distance = Math.hypot(dx, dy),
    nx = distance ? -dy / distance : 0,
    ny = distance ? dx / distance : 0;
  const bend = () => (random() * 2 - 1) * Math.min(60, distance * 0.15);
  const b1 = bend(),
    b2 = bend(),
    p1 = { x: origin.x + dx / 3 + nx * b1, y: origin.y + dy / 3 + ny * b1 },
    p2 = {
      x: origin.x + (dx * 2) / 3 + nx * b2,
      y: origin.y + (dy * 2) / 3 + ny * b2,
    };
  const duration = clamp(180 + 0.55 * distance + normal(random) * 35, 120, 900),
    steps = Math.ceil(duration / 24),
    jitter = Math.min(1.5, 0.03 * Math.min(box.width, box.height)),
    phase = random() * Math.PI * 2;
  const overshoot =
    random() < 0.05
      ? Math.min(8, distance * 0.08, Math.min(box.width, box.height) * 0.15)
      : 0;
  const end = {
    x: target.x + (distance ? (dx / distance) * overshoot : 0),
    y: target.y + (distance ? (dy / distance) * overshoot : 0),
  };
  const result: PointerSample[] = [];
  for (let i = 1; i <= steps; i++) {
    const s = i / steps,
      u = 10 * s ** 3 - 15 * s ** 4 + 6 * s ** 5,
      v = 1 - u,
      j = jitter * Math.sin(Math.PI * s) * Math.sin(4 * Math.PI * s + phase);
    result.push({
      atMs: duration * s,
      x:
        v ** 3 * origin.x +
        3 * v * v * u * p1.x +
        3 * v * u * u * p2.x +
        u ** 3 * end.x +
        nx * j,
      y:
        v ** 3 * origin.y +
        3 * v * v * u * p1.y +
        3 * v * u * u * p2.y +
        u ** 3 * end.y +
        ny * j,
    });
  }
  if (overshoot)
    result.push({ atMs: duration + 80 + random() * 100, ...target });
  else Object.assign(result[result.length - 1]!, target);
  return result;
}
export function planScroll(
  deltaY: number,
  seed: string,
): { atMs: number; deltaY: number }[] {
  if (!Number.isFinite(deltaY) || Math.abs(deltaY) > 10_000)
    throw new Error("Scroll must be at most 10000 pixels");
  if (!deltaY) return [];
  const random = seededRandom(`${seed}:scroll`),
    steps = clamp(Math.ceil(Math.abs(deltaY) / 90), 3, 10),
    weights = Array.from({ length: steps }, (_, i) => Math.exp(-i / 2)),
    total = weights.reduce((a, b) => a + b, 0);
  let atMs = 0;
  return weights.map((weight) => {
    const event = { atMs, deltaY: (deltaY * weight) / total };
    atMs += 35 + random() * 55;
    return event;
  });
}
