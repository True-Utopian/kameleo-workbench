import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";
import type {
  CompiledFlow,
  FlowManifest,
  FlowPack,
  FlowStep,
  Predicate,
  Routes,
  ValueRef,
} from "./types.js";

const ajv = new Ajv2020({ strict: true, allErrors: true });
ajv.addSchema(
  JSON.parse(
    readFileSync(
      new URL("../../schemas/state-registry.schema.json", import.meta.url),
      "utf8",
    ),
  ),
);
const structure = ajv.compile(
  JSON.parse(
    readFileSync(
      new URL("../../schemas/flow-pack.schema.json", import.meta.url),
      "utf8",
    ),
  ),
);
export class FlowCompileError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid flow pack: ${issues.join("; ")}`);
    this.name = "FlowCompileError";
  }
}
export const predicateKey = (predicate: Predicate): string =>
  JSON.stringify(predicate);
export function collectPredicates(pack: FlowPack): Predicate[] {
  const predicates = Object.values(pack.registry.states).flatMap((s) => [
    ...s.require,
    ...s.forbid,
    ...s.support.map((p) => p.predicate),
  ]);
  for (const step of Object.values(pack.steps))
    if (step.kind === "action") predicates.push(...step.postcondition.require);
  return [...new Map(predicates.map((p) => [predicateKey(p), p])).values()];
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
export function compileFlow(
  value: unknown,
  bindings: FlowManifest,
): CompiledFlow {
  const json = JSON.stringify(value);
  if (json.length > 1_000_000)
    throw new FlowCompileError(["pack exceeds 1 MB"]);
  const data: unknown = JSON.parse(json);
  if (!structure(data))
    throw new FlowCompileError(
      (structure.errors || []).map(
        (e) => `${e.instancePath || "/"} ${e.message}`,
      ),
    );
  const pack = data as FlowPack;
  const manifest = structuredClone(bindings);
  const errors: string[] = [];
  const error = (message: string) => {
    errors.push(message);
  };
  const { states, targets } = pack.registry;
  const steps = pack.steps;
  const hasState = (id: string) => Object.hasOwn(states, id);
  const hasStep = (id: string) => Object.hasOwn(steps, id);
  const requireState = (id: string, where: string, review = false) => {
    if (!(hasState(id) || (review && id === "unknown")))
      error(`${where}: unknown state ${id}`);
  };
  const target = (id: string, unique = false) => {
    if (!Object.hasOwn(targets, id)) error(`unknown target ${id}`);
    else if (unique && targets[id]!.cardinality !== "one")
      error(`${id}: action targets must be unique`);
  };
  const origin = (id: string, pathname: string) => {
    if (!pack.registry.originRefs.includes(id)) {
      error(`unknown origin ${id}`);
      return;
    }
    try {
      const url = new URL(pathname, manifest.origins[id]);
      if (
        url.origin !== manifest.origins[id] ||
        url.pathname !== pathname ||
        url.search ||
        url.hash ||
        url.username ||
        url.password
      )
        error(`invalid path for origin ${id}`);
    } catch {
      error(`invalid origin ${id}`);
    }
  };
  const predicate = (p: Predicate) => {
    if ("target" in p) target(p.target);
    else origin(p.originRef, p.pathname);
  };
  for (const id of pack.registry.originRefs) {
    try {
      const url = new URL(manifest.origins[id]!);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.origin !== manifest.origins[id] ||
        url.username ||
        url.password
      )
        error(`origin ${id} must be an exact HTTP(S) origin`);
    } catch {
      error(`missing origin ${id}`);
    }
  }
  if (!manifest.profilePolicyIds?.includes(pack.execution.profilePolicyId))
    error("profile policy is not installed");
  if (!manifest.proxyPolicyIds?.includes(pack.execution.proxyPolicyId))
    error("proxy policy is not installed");
  if (
    manifest.identityPolicy === "required" &&
    pack.identityPolicy !== "required"
  )
    error("identity policy cannot be downgraded");
  if (pack.evidence.screenshots !== "off")
    error("masked screenshots are not supported by this interpreter");
  origin(pack.start.originRef, pack.start.pathname);
  const policy = pack.registry.policy;
  if (
    policy.maxObservationAgeMs < policy.stableForMs ||
    policy.unknownTimeoutMs < policy.blankGraceMs
  )
    error("inconsistent observation timing");
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) {
      error("state refinement cycle");
      return;
    }
    if (visited.has(id) || !states[id]) return;
    visiting.add(id);
    for (const parent of states[id]!.refines || []) {
      requireState(parent, id);
      visit(parent);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const [id, rule] of Object.entries(states)) {
    visit(id);
    [
      ...rule.require,
      ...rule.forbid,
      ...rule.support.map((p) => p.predicate),
    ].forEach(predicate);
    if (new Set(rule.support.map((p) => p.id)).size !== rule.support.length)
      error(`${id}: duplicate evidence ID`);
  }
  const inspectSchema = (node: unknown, depth = 0): void => {
    if (depth > 20) {
      error("input schema nesting exceeds 20");
      return;
    }
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    if (typeof n.$ref === "string" && !n.$ref.startsWith("#"))
      error("remote schema references are forbidden");
    if (n.writeOnly && Object.hasOwn(n, "default"))
      error("secret defaults are forbidden");
    for (const child of Object.values(n)) inspectSchema(child, depth + 1);
  };
  inspectSchema(pack.inputSchema);
  if (pack.inputSchema.type !== "object")
    error("input schema must be an object");
  let validateInputs;
  try {
    validateInputs = new Ajv2020({ strict: true, allErrors: true }).compile(
      pack.inputSchema,
    );
  } catch {
    error("invalid input schema");
  }
  for (const [id, source] of Object.entries(pack.choices)) {
    target(source.container, true);
    const exact: string[] = [];
    const matchers: ((key: string) => boolean)[] = [];
    if (
      new Set(source.patterns.map((p) => p.id)).size !== source.patterns.length
    )
      error(`${id}: duplicate choice pattern ID`);
    for (const rule of source.patterns) {
      if (rule.match.keyEquals !== undefined) {
        const key = rule.match.keyEquals;
        exact.push(key);
        matchers.push((k) => k === key);
      } else {
        const pattern = rule.match.keyPattern;
        if (
          !/^\^[a-zA-Z0-9_-]*(?:\[(?:a-z|A-Z|0-9|-)+\][+*])?[a-zA-Z0-9_-]*\$$/.test(
            pattern,
          )
        ) {
          error(`${id}: unsupported key pattern`);
          continue;
        }
        const re = new RegExp(pattern);
        matchers.push((k) => re.test(k));
      }
    }
    for (const key of exact)
      if (matchers.filter((matches) => matches(key)).length > 1)
        error(`${id}: overlapping choice patterns`);
    for (const state of source.states) {
      requireState(state, id);
      if (states[state] && !states[state]!.actionable)
        error(`${id}: non-actionable choice state`);
    }
    const stale = steps[source.onStale];
    if (
      !stale ||
      stale.kind !== "input" ||
      stale.input.kind !== "choice" ||
      stale.input.choiceSource !== id
    )
      error(`${id}: stale route must reacquire this choice`);
    if (steps[source.onAllUnavailable]?.kind !== "review")
      error(`${id}: unavailable route must review`);
  }
  type Edge = { from: string; to: string; kind: string };
  const edges: Edge[] = [];
  const seeds = new Set<string>();
  const edge = (from: string, to: string, kind: string) => {
    if (!hasStep(to)) error(`${from}: missing ${kind} step ${to}`);
    else edges.push({ from, to, kind });
  };
  const routes = (
    from: string,
    map: Routes,
    kind: string,
    allowed?: string[],
  ) => {
    for (const [state, to] of Object.entries(map)) {
      requireState(state, from, kind === "recovery");
      edge(from, to, kind);
      if (allowed && !allowed.includes(state))
        error(`${from}: unexpected route state ${state}`);
      if (steps[to] && !steps[to]!.requires.includes(state))
        error(`${from}: destination does not accept ${state}`);
    }
    if (
      allowed &&
      (Object.keys(map).length !== allowed.length ||
        allowed.some((s) => !Object.hasOwn(map, s)))
    )
      error(`${from}: missing state branch`);
  };
  const choice = (sourceId: string, id: string, requires: string[]) => {
    const source = pack.choices[sourceId];
    if (!source) {
      error(`${id}: missing choice source`);
      return;
    }
    if (!requires.every((s) => source.states.includes(s)))
      error(`${id}: choice states mismatch`);
    edge(id, source.onStale, "stale");
    edge(id, source.onAllUnavailable, "unavailable");
    for (const to of [source.onStale, source.onAllUnavailable])
      if (
        steps[to] &&
        !source.states.every((s) => steps[to]!.requires.includes(s))
      )
        error(`${id}: choice destination state mismatch`);
  };
  for (const [state, to] of Object.entries(pack.entryByState)) {
    requireState(state, "entry");
    seeds.add(to);
    if (
      !hasStep(to) ||
      !steps[to]!.requires.includes(state) ||
      !states[state]?.actionable
    )
      error("invalid entry route");
  }
  seeds.add(pack.onUnexpectedStep);
  if (steps[pack.onUnexpectedStep]?.kind !== "review")
    error("unexpected route must review");
  for (const [id, step] of Object.entries(steps)) {
    for (const s of step.requires) {
      requireState(s, id, step.kind === "review");
      if (step.kind !== "review" && states[s] && !states[s]!.actionable)
        error(`${id}: non-actionable state`);
    }
    if (step.kind !== "complete") routes(id, step.recoveryByState, "recovery");
    if (step.kind === "complete" || step.kind === "review") continue;
    for (const branch of ["onError", "onTimeout", "onUncertain"] as const) {
      edge(id, step[branch], branch);
      if (steps[step[branch]]?.kind !== "review")
        error(`${id}: failure route must review`);
    }
    if (step.kind === "input") {
      routes(id, step.next, "success", step.requires);
      if (step.input.kind === "choice")
        choice(step.input.choiceSource, id, step.requires);
      else if (step.input.minLength > step.input.maxLength)
        error(`${id}: invalid input length`);
    } else {
      const op = step.do;
      if ("target" in op) target(op.target, true);
      if (op.op === "navigate") origin(op.originRef, op.pathname);
      step.postcondition.require.forEach(predicate);
      step.postcondition.states.forEach((s) => requireState(s, id));
      routes(id, step.next, "success", step.postcondition.states);
      if (op.op === "chooseOption") choice(op.choiceSource, id, step.requires);
      if (
        op.op === "bindIdentity" &&
        !manifest.identityResolvers?.includes(op.resolver)
      )
        error(`${id}: identity resolver is not installed`);
      if (
        step.retry.mode === "safe-repeat" &&
        !(
          op.op === "wait" ||
          (op.op === "fill" &&
            manifest.safeRepeatTargets?.includes(op.target)) ||
          (op.op === "navigate" &&
            manifest.safeNavigationPaths?.includes(
              `${op.originRef}:${op.pathname}`,
            ))
        )
      )
        error(`${id}: unsafe retry`);
      if (
        step.retry.mode === "reconcile" &&
        !manifest.reconciliationResolvers?.includes(step.retry.resolver)
      )
        error(`${id}: reconciliation resolver is not installed`);
    }
  }
  const reached = new Set([...seeds].filter(hasStep));
  const pending = [...reached];
  while (pending.length) {
    const from = pending.pop();
    for (const e of edges.filter((e) => e.from === from))
      if (!reached.has(e.to)) {
        reached.add(e.to);
        pending.push(e.to);
      }
  }
  for (const id of Object.keys(steps))
    if (!reached.has(id)) error(`${id}: unreachable step`);
  if (![...reached].some((id) => steps[id]?.kind === "complete"))
    error("no reachable completion");
  const base = new Set(
    (pack.inputSchema.required || [])
      .filter((k) => Object.hasOwn(pack.inputSchema.properties || {}, k))
      .map((k) => `input:${k}`),
  );
  const output = (step: FlowStep): string | undefined =>
    step.kind === "input"
      ? `answer:${step.answerKey}`
      : step.kind === "action" && step.do.op === "scrape"
        ? `capture:${step.do.outputKey}`
        : step.kind === "action" && step.do.op === "bindIdentity"
          ? `receipt:${step.do.receiptKey}`
          : undefined;
  const universe = new Set([
    ...base,
    ...Object.values(steps)
      .map(output)
      .filter((v): v is string => !!v),
  ]);
  const available = new Map(
    Object.keys(steps).map((id) => [id, new Set(universe)]),
  );
  const transfer = (e: Edge) => {
    const source = steps[e.from]!;
    if (e.kind !== "success" || source.kind === "review") return new Set(base);
    const values = new Set(available.get(e.from));
    const produced = output(source);
    if (produced) values.add(produced);
    if (source.kind === "action") {
      if (source.do.op === "fill" && source.do.value.source === "answer")
        values.delete(`answer:${source.do.value.key}`);
      if (source.do.op === "chooseOption")
        values.delete(`answer:${source.do.answerKey}`);
      if (source.do.op === "navigate")
        for (const key of values)
          if (key.startsWith("receipt:")) values.delete(key);
    }
    return values;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of reached) {
      const inbound = edges.filter((e) => e.to === id).map(transfer);
      if (seeds.has(id)) inbound.push(new Set(base));
      const next = inbound.length
        ? inbound.reduce((a, b) => new Set([...a].filter((k) => b.has(k))))
        : new Set(base);
      const prev = available.get(id)!;
      if (next.size !== prev.size || [...next].some((k) => !prev.has(k))) {
        available.set(id, next);
        changed = true;
      }
    }
  }
  for (const [id, step] of Object.entries(steps)) {
    const valueRef = (ref: ValueRef) => {
      if (
        ref.source !== "literal" &&
        !available.get(id)!.has(`${ref.source}:${ref.key}`)
      )
        error(`${id}: value is not definitely assigned`);
    };
    if (step.kind === "action") {
      if (step.do.op === "fill") valueRef(step.do.value);
      if (step.do.op === "bindIdentity") valueRef(step.do.expected);
      if (step.do.op === "chooseOption")
        valueRef({ source: "answer", key: step.do.answerKey });
    }
    if (
      step.kind === "complete" &&
      (pack.identityPolicy === "required" || step.identityReceipt) &&
      !available.get(id)!.has(`receipt:${step.identityReceipt}`)
    )
      error(`${id}: identity receipt is not definitely assigned`);
  }
  if (errors.length || !validateInputs)
    throw new FlowCompileError([...new Set(errors)]);
  return {
    pack: freeze(pack),
    manifest: freeze(manifest),
    hash: createHash("sha256")
      .update(JSON.stringify({ pack, manifest }))
      .digest("hex"),
    validateInputs,
    predicates: collectPredicates(pack),
  };
}
