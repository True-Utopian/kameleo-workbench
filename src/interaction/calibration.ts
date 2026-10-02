import {
  DEFAULT_INTERACTION_MODEL,
  digraphKey,
  seededRandom,
  transitionKey,
  validateModel,
} from "./model.js";
import type {
  InteractionModel,
  InteractionTrace,
  TimingGroup,
  TraceEvent,
} from "./types.js";

const assertions = [
  "correctValue",
  "correctFocus",
  "noDuplicateSubmit",
  "noSecretCapture",
  "keysReleased",
] as const;
export function validateTrace(trace: InteractionTrace): void {
  if (
    !trace ||
    trace.schemaVersion !== 1 ||
    !["human", "synthetic"].includes(trace.source) ||
    !["train", "development", "holdout"].includes(trace.split) ||
    trace.consent?.granted !== true ||
    trace.consent.purpose !== "owned-site-synthetic-testing" ||
    trace.syntheticTask !== true
  )
    throw new Error(
      "Only explicitly consented synthetic-task traces are accepted",
    );
  for (const key of [
    "participantId",
    "sessionId",
    "taskId",
    "deviceClass",
    "keyboardLayout",
  ] as const)
    if (
      typeof trace[key] !== "string" ||
      !/^[a-zA-Z0-9_.:-]{1,120}$/.test(trace[key])
    )
      throw new Error("Trace identifiers must be bounded opaque labels");
  if (
    !trace.assertions ||
    assertions.some((key) => typeof trace.assertions[key] !== "boolean") ||
    !Array.isArray(trace.events) ||
    trace.events.length > 100_000
  )
    throw new Error("Invalid trace assertions or event count");
  let previous = -1;
  for (const event of trace.events) {
    if (
      !event ||
      !Number.isFinite(event.atMs) ||
      event.atMs < previous ||
      event.atMs < 0 ||
      event.atMs > 86_400_000 ||
      !["keydown", "keyup", "pointer", "scroll"].includes(event.kind)
    )
      throw new Error("Invalid or unordered trace event");
    previous = event.atMs;
    if (event.kind === "keydown" || event.kind === "keyup") {
      if (
        typeof event.key !== "string" ||
        !/^(?:[ -~]|Backspace|Tab|Enter|Shift|Control|Alt|Meta|ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Home|End|Delete)$/.test(
          event.key,
        ) ||
        typeof event.field !== "string" ||
        !/^[a-zA-Z0-9_-]{1,80}$/.test(event.field)
      )
        throw new Error("Invalid synthetic key event");
    } else if (
      event.kind === "pointer" &&
      [event.x, event.y].some(
        (n) =>
          typeof n !== "number" || !Number.isFinite(n) || Math.abs(n) > 1e6,
      )
    )
      throw new Error("Invalid pointer event");
    else if (
      event.kind === "scroll" &&
      (!Number.isFinite(event.deltaY) || Math.abs(event.deltaY!) > 100_000)
    )
      throw new Error("Invalid scroll event");
  }
}
interface Pair {
  a: string;
  b: string;
  h: number;
  g: number;
  field: string;
}
function pairs(trace: InteractionTrace): Pair[] {
  const down: { event: TraceEvent; up?: number }[] = [],
    pending = new Map<string, number>();
  for (const event of trace.events) {
    if (!["keydown", "keyup"].includes(event.kind)) continue;
    const key = `${event.field}:${event.key}`;
    if (event.kind === "keydown") {
      if (pending.has(key)) continue; // Ignore held-key auto-repeat.
      pending.set(key, down.length);
      down.push({ event });
    } else {
      const index = pending.get(key);
      if (index !== undefined) {
        down[index]!.up = event.atMs;
        pending.delete(key);
      }
    }
  }
  const result: Pair[] = [];
  for (let i = 0; i + 1 < down.length; i++) {
    const a = down[i]!,
      b = down[i + 1]!,
      h = (a.up ?? NaN) - a.event.atMs,
      g = b.event.atMs - a.event.atMs;
    if (
      a.event.field === b.event.field &&
      /^[a-z0-9 ]$/.test(a.event.key!) &&
      /^[a-z0-9 ]$/.test(b.event.key!) &&
      h > 0 &&
      h <= 10_000 &&
      g > 0 &&
      g <= 10_000
    )
      result.push({
        a: a.event.key!,
        b: b.event.key!,
        field: a.event.field!,
        h,
        g,
      });
  }
  return result;
}
function fit(
  values: { h: number; g: number; weight: number }[],
  parent: TimingGroup,
  kappa: number,
): TimingGroup {
  const count = values.reduce((sum, value) => sum + value.weight, 0);
  if (!count) return structuredClone(parent);
  const means: [number, number] = [0, 0];
  for (const value of values) {
    means[0] += (Math.log(value.h) * value.weight) / count;
    means[1] += (Math.log(value.g) * value.weight) / count;
  }
  const covariance: [number, number, number] = [0, 0, 0];
  for (const value of values) {
    const x = Math.log(value.h) - means[0],
      y = Math.log(value.g) - means[1];
    covariance[0] += (x * x * value.weight) / count;
    covariance[1] += (x * y * value.weight) / count;
    covariance[2] += (y * y * value.weight) / count;
  }
  const w = count / (count + kappa),
    mean: [number, number] = [
      w * means[0] + (1 - w) * parent.mean[0],
      w * means[1] + (1 - w) * parent.mean[1],
    ];
  const cov: [number, number, number] = [
    w * covariance[0] + (1 - w) * parent.covariance[0] + 1e-6,
    w * covariance[1] + (1 - w) * parent.covariance[1],
    w * covariance[2] + (1 - w) * parent.covariance[2] + 1e-6,
  ];
  return { count, mean, covariance: cov };
}
export function calibrateInteraction(
  traces: InteractionTrace[],
  options: { version?: string; kappa?: number } = {},
): InteractionModel {
  if (!traces.length || traces.length > 10_000)
    throw new Error("Training traces are required");
  const kappa = options.kappa ?? 50;
  if (!Number.isFinite(kappa) || kappa < 1 || kappa > 100_000)
    throw new Error("Invalid shrinkage strength");
  traces.forEach(validateTrace);
  if (
    traces.some(
      (trace) =>
        trace.source !== "human" ||
        trace.split !== "train" ||
        !assertions.every((key) => trace.assertions[key]),
    )
  )
    throw new Error(
      "Calibration requires passing human training traces, never holdout data",
    );
  const first = traces[0]!;
  if (
    traces.some(
      (trace) =>
        trace.keyboardLayout !== first.keyboardLayout ||
        trace.deviceClass !== first.deviceClass,
    )
  )
    throw new Error("Fit a separate model for each device/layout stratum");
  if (new Set(traces.map((trace) => trace.sessionId)).size !== traces.length)
    throw new Error("Duplicate training session");
  const participantCounts = new Map<string, number>();
  for (const trace of traces)
    participantCounts.set(
      trace.participantId,
      (participantCounts.get(trace.participantId) ?? 0) + 1,
    );
  const weighted = traces.flatMap((trace) => {
    const data = pairs(trace);
    const weight =
      100 /
      Math.max(1, data.length) /
      participantCounts.get(trace.participantId)!;
    return data.map((pair) => ({ ...pair, weight }));
  });
  if (weighted.length < 10)
    throw new Error("At least ten valid timing pairs are required");
  const global = fit(weighted, DEFAULT_INTERACTION_MODEL.global, kappa),
    transitions: Record<string, TimingGroup> = {},
    digraphs: Record<string, TimingGroup> = {};
  for (const group of new Set(
    weighted.map((pair) => transitionKey(pair.a, pair.b)),
  ))
    transitions[group] = fit(
      weighted.filter((pair) => transitionKey(pair.a, pair.b) === group),
      global,
      kappa,
    );
  for (const key of new Set(
    weighted.map((pair) => digraphKey(pair.a, pair.b)),
  )) {
    const values = weighted.filter(
      (pair) => digraphKey(pair.a, pair.b) === key,
    );
    digraphs[key] = fit(
      values,
      transitions[transitionKey(values[0]!.a, values[0]!.b)]!,
      kappa,
    );
  }
  const model: InteractionModel = {
    schemaVersion: 1,
    version: options.version ?? "consented-fit-1",
    calibrated: true,
    deviceClass: first.deviceClass,
    keyboardLayout: first.keyboardLayout,
    global,
    transitions,
    digraphs,
    trainingParticipants: [...participantCounts.keys()],
    trainingSessions: traces.map((trace) => trace.sessionId),
  };
  validateModel(model);
  return model;
}

export type Metric =
  | "dwell"
  | "flight"
  | "interval"
  | "pointerSpeed"
  | "pathEfficiency"
  | "scrollDistance"
  | "duration";
const quantile = (values: number[], q: number) => {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b),
    index = (sorted.length - 1) * q,
    left = Math.floor(index);
  return (
    sorted[left]! + (sorted[Math.ceil(index)]! - sorted[left]!) * (index - left)
  );
};
type Features = Record<Metric, number[]> & {
  rollover: number;
  correction: number;
  correlations: number[];
};
function features(
  trace: InteractionTrace,
  cache: Map<TraceEvent[], Features>,
): Features {
  const cached = cache.get(trace.events);
  if (cached) return cached;
  const data = pairs(trace),
    dwell = data.map((pair) => pair.h),
    interval = data.map((pair) => pair.g),
    points = trace.events.filter((event) => event.kind === "pointer");
  let length = 0;
  const pointerSpeed: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!,
      b = points[i]!,
      distance = Math.hypot(b.x! - a.x!, b.y! - a.y!);
    length += distance;
    if (b.atMs > a.atMs)
      pointerSpeed.push((distance * 1000) / (b.atMs - a.atMs));
  }
  const pathEfficiency =
    points.length > 1 && length > 0
      ? [
          Math.hypot(
            points.at(-1)!.x! - points[0]!.x!,
            points.at(-1)!.y! - points[0]!.y!,
          ) / length,
        ]
      : [];
  const result = {
    dwell,
    interval,
    flight: data.map((pair) => pair.g - pair.h),
    pointerSpeed,
    pathEfficiency,
    scrollDistance: trace.events
      .filter((event) => event.kind === "scroll")
      .map((event) => event.deltaY!),
    duration: trace.events.length
      ? [trace.events.at(-1)!.atMs - trace.events[0]!.atMs]
      : [],
    rollover: data.length
      ? data.filter((pair) => pair.g < pair.h).length / data.length
      : NaN,
    correction:
      trace.events.filter(
        (event) => event.kind === "keydown" && event.key === "Backspace",
      ).length /
      Math.max(
        1,
        trace.events.filter((event) => event.kind === "keydown").length,
      ),
    correlations: [
      spearman(dwell, interval),
      spearman(interval.slice(0, -1), interval.slice(1)),
    ],
  };
  cache.set(trace.events, result);
  return result;
}
function spearman(a: number[], b: number[]): number {
  if (a.length < 3 || a.length !== b.length) return NaN;
  const ranks = (values: number[]) => {
    const ordered = values
        .map((value, index) => ({ value, index }))
        .sort((a, b) => a.value - b.value),
      result: number[] = [];
    for (let start = 0; start < ordered.length; ) {
      let end = start + 1;
      while (
        end < ordered.length &&
        ordered[end]!.value === ordered[start]!.value
      )
        end++;
      for (let i = start; i < end; i++)
        result[ordered[i]!.index] = (start + end + 1) / 2;
      start = end;
    }
    return result;
  };
  const x = ranks(a),
    y = ranks(b),
    mean = (a.length + 1) / 2;
  let numerator = 0,
    va = 0,
    vb = 0;
  for (let i = 0; i < a.length; i++) {
    const dx = x[i]! - mean,
      dy = y[i]! - mean;
    numerator += dx * dy;
    va += dx * dx;
    vb += dy * dy;
  }
  return va && vb ? numerator / Math.sqrt(va * vb) : NaN;
}
interface WeightedValue {
  value: number;
  weight: number;
}
function traceWeights(
  traces: InteractionTrace[],
): { trace: InteractionTrace; weight: number }[] {
  const groups = new Map<string, InteractionTrace[]>();
  for (const trace of traces) {
    const key =
      trace.source === "human" ? trace.participantId : trace.sessionId;
    const list = groups.get(key) ?? [];
    list.push(trace);
    groups.set(key, list);
  }
  return [...groups.values()].flatMap((group) => {
    const tasks = [...new Set(group.map((trace) => trace.taskId))];
    return group.map((trace) => ({
      trace,
      weight:
        1 /
        groups.size /
        tasks.length /
        group.filter((other) => other.taskId === trace.taskId).length,
    }));
  });
}
function balanced(
  traces: InteractionTrace[],
  metric: Metric,
  cache: Map<TraceEvent[], Features>,
): WeightedValue[] {
  return traceWeights(traces).flatMap(({ trace, weight }) => {
    const values = features(trace, cache)[metric];
    return values.map((value) => ({ value, weight: weight / values.length }));
  });
}
function weightedQuantile(values: WeightedValue[], q: number): number {
  let sum = 0;
  for (const item of [...values].sort((a, b) => a.value - b.value)) {
    sum += item.weight;
    if (sum >= q) return item.value;
  }
  return values.at(-1)?.value ?? NaN;
}
function wasserstein(a: WeightedValue[], b: WeightedValue[]): number {
  const points = [
    ...a.map((item) => ({ ...item, sign: 1 })),
    ...b.map((item) => ({ ...item, sign: -1 })),
  ].sort((x, y) => x.value - y.value);
  let mass = 0,
    previous = points[0]?.value ?? 0,
    distance = 0;
  for (const point of points) {
    distance += Math.abs(mass) * (point.value - previous);
    mass += point.sign * point.weight;
    previous = point.value;
  }
  return distance;
}
const floors: Record<Metric, number> = {
  dwell: 10,
  flight: 10,
  interval: 10,
  pointerSpeed: 50,
  pathEfficiency: 0.05,
  scrollDistance: 25,
  duration: 50,
};
const average = (values: number[]) =>
  values.length && values.every(Number.isFinite)
    ? values.reduce((a, b) => a + b, 0) / values.length
    : NaN;
function calculate(
  human: InteractionTrace[],
  synthetic: InteractionTrace[],
  metrics: Metric[],
  cache: Map<TraceEvent[], Features>,
) {
  const distances: Partial<Record<Metric, number>> = {};
  for (const metric of metrics) {
    const h = balanced(human, metric, cache),
      s = balanced(synthetic, metric, cache);
    const complete = [...human, ...synthetic].every(
      (trace) => features(trace, cache)[metric].length > 0,
    );
    distances[metric] =
      complete && h.length && s.length
        ? wasserstein(h, s) /
          Math.max(
            floors[metric],
            weightedQuantile(h, 0.75) - weightedQuantile(h, 0.25),
          )
        : NaN;
  }
  const summary = (
    traces: InteractionTrace[],
    get: (value: Features) => number,
  ) =>
    traceWeights(traces).reduce(
      (total, item) => total + item.weight * get(features(item.trace, cache)),
      0,
    );
  const distribution = average(Object.values(distances)),
    correlation = average(
      [0, 1].map(
        (i) =>
          Math.abs(
            summary(human, (item) => item.correlations[i]!) -
              summary(synthetic, (item) => item.correlations[i]!),
          ) / 2,
      ),
    ),
    rates = average(
      ["rollover", "correction"].map((key) =>
        Math.abs(
          summary(human, (item) => item[key as "rollover"]) -
            summary(synthetic, (item) => item[key as "rollover"]),
        ),
      ),
    );
  return {
    score:
      100 * Math.exp(-(0.55 * distribution + 0.25 * correlation + 0.2 * rates)),
    distribution,
    correlation,
    rates,
    distances,
    maximumDistance: Math.max(...Object.values(distances)),
  };
}
export interface InteractionScore {
  validated: boolean;
  passed: boolean;
  coverage: {
    participants: number;
    humanSessions: number;
    syntheticSessions: number;
    minimumParticipants: number;
  };
  correctness: boolean;
  reasons: string[];
  estimate: ReturnType<typeof calculate>;
  intervals: Record<
    "score" | "distribution" | "correlation" | "rates" | "maximumDistance",
    [number, number]
  >;
  bootstrapSamples: number;
}
export function scoreInteraction(
  model: InteractionModel,
  human: InteractionTrace[],
  synthetic: InteractionTrace[],
  options: {
    seed?: string;
    bootstrapSamples?: number;
    minimumParticipants?: number;
    metrics?: Metric[];
  } = {},
): InteractionScore {
  validateModel(model);
  if (!human.length || !synthetic.length)
    throw new Error("Both human and synthetic holdout traces are required");
  [...human, ...synthetic].forEach(validateTrace);
  if (
    human.some((trace) => trace.source !== "human") ||
    synthetic.some((trace) => trace.source !== "synthetic") ||
    [...human, ...synthetic].some(
      (trace) =>
        trace.split !== "holdout" ||
        trace.deviceClass !== model.deviceClass ||
        trace.keyboardLayout !== model.keyboardLayout,
    )
  )
    throw new Error(
      "Scoring requires held-out traces in the model device/layout stratum",
    );
  if (
    human.some((trace) =>
      model.trainingParticipants.includes(trace.participantId),
    ) ||
    [...human, ...synthetic].some((trace) =>
      model.trainingSessions.includes(trace.sessionId),
    )
  )
    throw new Error("Training/holdout participant or session leakage");
  const sessions = [...human, ...synthetic].map((trace) => trace.sessionId);
  if (new Set(sessions).size !== sessions.length)
    throw new Error("Duplicate holdout session");
  const tasks = (traces: InteractionTrace[]) =>
    [...new Set(traces.map((trace) => trace.taskId))].sort().join("|");
  if (tasks(human) !== tasks(synthetic))
    throw new Error("Human and synthetic tasks must match");
  const metrics = options.metrics ?? ["dwell", "flight", "interval"];
  if (!metrics.length || metrics.some((metric) => !(metric in floors)))
    throw new Error("Invalid required metrics");
  const samples = options.bootstrapSamples ?? 2000,
    minimum = options.minimumParticipants ?? 20;
  if (
    !Number.isInteger(samples) ||
    samples < 20 ||
    samples > 10_000 ||
    !Number.isInteger(minimum) ||
    minimum < 1
  )
    throw new Error("Invalid score sample count");
  const cache = new Map<TraceEvent[], Features>();
  const estimate = calculate(human, synthetic, metrics, cache),
    correctness = [...human, ...synthetic].every((trace) =>
      assertions.every((key) => trace.assertions[key]),
    ),
    reasons: string[] = [];
  const participantIds = [
    ...new Set(human.map((trace) => trace.participantId)),
  ];
  if (
    participantIds.length < minimum ||
    participantIds.some(
      (id) => human.filter((trace) => trace.participantId === id).length < 2,
    )
  )
    reasons.push("insufficient_participant_session_coverage");
  if (!Number.isFinite(estimate.score))
    reasons.push("missing_or_degenerate_required_features");
  if (!correctness) reasons.push("correctness_gate_failed");
  if (!model.calibrated) reasons.push("uncalibrated_fixture_model");
  const random = seededRandom(options.seed ?? "score-bootstrap-1"),
    keys = [
      "score",
      "distribution",
      "correlation",
      "rates",
      "maximumDistance",
    ] as const,
    values = Object.fromEntries(
      keys.map((key) => [key, [] as number[]]),
    ) as Record<(typeof keys)[number], number[]>;
  const bootstrap = (traces: InteractionTrace[], byParticipant: boolean) => {
    const ids = [
        ...new Set(
          traces.map((trace) =>
            byParticipant ? trace.participantId : trace.sessionId,
          ),
        ),
      ],
      result: InteractionTrace[] = [];
    for (let i = 0; i < ids.length; i++) {
      const chosen = ids[Math.floor(random() * ids.length)]!;
      for (const trace of traces.filter(
        (trace) =>
          (byParticipant ? trace.participantId : trace.sessionId) === chosen,
      ))
        result.push({
          ...trace,
          participantId: `${i}`,
          sessionId: `${i}:${trace.sessionId}`,
        });
    }
    return result;
  };
  if (Number.isFinite(estimate.score))
    for (let i = 0; i < samples; i++) {
      const score = calculate(
        bootstrap(human, true),
        bootstrap(synthetic, false),
        metrics,
        cache,
      );
      for (const key of keys) values[key].push(score[key]);
    }
  const intervals = Object.fromEntries(
    keys.map((key) => [
      key,
      [quantile(values[key], 0.025), quantile(values[key], 0.975)],
    ]),
  ) as InteractionScore["intervals"];
  const passed =
    reasons.length === 0 &&
    intervals.score[0] >= 85 &&
    intervals.distribution[1] <= 0.2 &&
    intervals.correlation[1] <= 0.1 &&
    intervals.rates[1] <= 0.05 &&
    intervals.maximumDistance[1] <= 0.5;
  if (!passed && reasons.length === 0)
    reasons.push("proposed_similarity_threshold_failed");
  return {
    validated: passed,
    passed,
    coverage: {
      participants: participantIds.length,
      humanSessions: human.length,
      syntheticSessions: synthetic.length,
      minimumParticipants: minimum,
    },
    correctness,
    reasons,
    estimate,
    intervals,
    bootstrapSamples: samples,
  };
}
