import type { InteractionModel, TimingGroup } from "./types.js";

export const DEFAULT_INTERACTION_MODEL: InteractionModel = {
  schemaVersion: 1,
  version: "fixture-1-uncalibrated",
  calibrated: false,
  deviceClass: "desktop",
  keyboardLayout: "ascii",
  global: {
    count: 0,
    mean: [Math.log(80), Math.log(180)],
    covariance: [0.35 ** 2, 0.25 * 0.35 * 0.45, 0.45 ** 2],
  },
  transitions: {},
  digraphs: {},
  trainingParticipants: [],
  trainingSessions: [],
};
export const clamp = (n: number, min: number, max: number) =>
  Math.max(min, Math.min(max, n));
export function seededRandom(seed: string): () => number {
  if (typeof seed !== "string" || !seed.length || seed.length > 1024)
    throw new Error("A bounded nonempty interaction seed is required");
  let value = 2166136261;
  for (const char of seed)
    value = Math.imul(value ^ char.charCodeAt(0), 16777619);
  return () => {
    value += 0x6d2b79f5;
    let n = value;
    n = Math.imul(n ^ (n >>> 15), n | 1);
    n ^= n + Math.imul(n ^ (n >>> 7), n | 61);
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
  };
}
export function normal(random: () => number): number {
  return (
    Math.sqrt(-2 * Math.log(Math.max(Number.EPSILON, random()))) *
    Math.cos(2 * Math.PI * random())
  );
}
export const digraphKey = (a: string, b: string) => JSON.stringify([a, b]);
export function transitionKey(a: string, b: string): string {
  return a === b
    ? "repeat"
    : a === " " || b === " "
      ? "word-boundary"
      : /^[a-z]$/.test(a) && /^[a-z]$/.test(b)
        ? "letters"
        : "other";
}
export function validateModel(model: InteractionModel): void {
  if (
    !model ||
    model.schemaVersion !== 1 ||
    typeof model.version !== "string" ||
    !model.version ||
    typeof model.calibrated !== "boolean" ||
    typeof model.deviceClass !== "string" ||
    typeof model.keyboardLayout !== "string"
  )
    throw new Error("Invalid interaction model");
  const validateGroup = (group: TimingGroup) => {
    if (
      !group ||
      !Number.isFinite(group.count) ||
      group.count < 0 ||
      !Array.isArray(group.mean) ||
      group.mean.length !== 2 ||
      !Array.isArray(group.covariance) ||
      group.covariance.length !== 3 ||
      [...group.mean, ...group.covariance].some((n) => !Number.isFinite(n))
    )
      throw new Error("Invalid timing group");
    const [v0, cov, v1] = group.covariance;
    if (
      v0 <= 0 ||
      v1 <= 0 ||
      cov * cov >= v0 * v1 ||
      group.mean.some((n) => n < Math.log(1) || n > Math.log(10_000))
    )
      throw new Error("Invalid timing covariance or mean");
  };
  if (
    !model.transitions ||
    !model.digraphs ||
    Object.keys(model.transitions).length > 100 ||
    Object.keys(model.digraphs).length > 10_000 ||
    !Array.isArray(model.trainingParticipants) ||
    !Array.isArray(model.trainingSessions) ||
    [...model.trainingParticipants, ...model.trainingSessions].some(
      (id) => typeof id !== "string" || id.length > 200,
    )
  )
    throw new Error("Invalid model metadata");
  validateGroup(model.global);
  Object.values(model.transitions).forEach(validateGroup);
  Object.values(model.digraphs).forEach(validateGroup);
}
export function timingGroup(
  model: InteractionModel,
  a: string,
  b: string,
): TimingGroup {
  return (
    model.digraphs[digraphKey(a, b)] ??
    model.transitions[transitionKey(a, b)] ??
    model.global
  );
}
