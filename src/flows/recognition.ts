import { randomUUID, createHash } from "node:crypto";
import type { Page, Frame } from "puppeteer-core";
import { predicateKey } from "./compiler.js";
import type {
  CompiledFlow,
  Observation,
  Recognition,
  StateRegistry,
  Truth,
} from "./types.js";

export interface RecognitionHistory {
  stateId?: string;
  documentEpoch?: string;
  digest?: string;
  since?: number;
  samples: number;
}
export function classify(
  registry: StateRegistry,
  observation: Observation,
  history: RecognitionHistory = { samples: 0 },
  now = Date.now(),
): Recognition {
  const evidenceLog: Recognition["evidenceLog"] = [];
  const result = (
    status: Recognition["status"],
    candidates: Recognition["candidates"] = [],
    reason?: string,
  ): Recognition => {
    if (status !== "matched" && status !== "settling") {
      history.samples = 0;
      delete history.stateId;
    }
    return {
      status,
      actionable: false,
      observation,
      candidates,
      evidenceLog,
      reason,
    };
  };
  if (
    !observation.complete ||
    now - observation.observedAt > registry.policy.maxObservationAgeMs
  )
    return result("invalidated", [], "stale-or-incomplete");
  if (
    !observation.supported ||
    !observation.originRef ||
    !registry.originRefs.includes(observation.originRef)
  )
    return result("unsupported", [], "scope-or-surface");
  if (observation.blank) return result("blank");
  const ancestors = (id: string, seen = new Set<string>()): Set<string> => {
    for (const parent of registry.states[id]?.refines || [])
      if (!seen.has(parent)) {
        seen.add(parent);
        ancestors(parent, seen);
      }
    return seen;
  };
  const candidates: Recognition["candidates"] = [];
  const undecidable: string[] = [];
  for (const [id, rule] of Object.entries(registry.states)) {
    const inherited = [
      rule,
      ...[...ancestors(id)].map((parent) => registry.states[parent]!),
    ];
    const required = inherited
      .flatMap((s) => s.require)
      .map((p) => observation.evidence[predicateKey(p)] ?? "unknown");
    const forbidden = inherited
      .flatMap((s) => s.forbid)
      .map((p) => observation.evidence[predicateKey(p)] ?? "unknown");
    const weight = rule.support.reduce((sum, item) => sum + item.weight, 0);
    const rejected = required.includes(false) || forbidden.includes(true);
    const unknown =
      required.includes("unknown") || forbidden.includes("unknown");
    const score = weight
      ? rule.support.reduce(
          (sum, item) =>
            sum +
            (observation.evidence[predicateKey(item.predicate)] === true
              ? item.weight
              : 0),
          0,
        ) / weight
      : !rejected && !unknown
        ? 1
        : 0;
    const qualified = !rejected && !unknown && score >= rule.minEvidenceScore;
    evidenceLog.push({
      stateId: id,
      require: rule.require.map(
        (p) => observation.evidence[predicateKey(p)] ?? "unknown",
      ),
      forbid: rule.forbid.map(
        (p) => observation.evidence[predicateKey(p)] ?? "unknown",
      ),
      score,
      qualified,
      ...(rule.refines?.length ? { inheritedFrom: rule.refines } : {}),
    });
    if (rejected) continue;
    if (unknown) {
      undecidable.push(id);
      continue;
    }
    if (qualified) candidates.push({ stateId: id, score });
  }
  for (const evidence of evidenceLog) {
    if (!evidence.qualified) continue;
    const descendants = candidates
      .filter((c) => ancestors(c.stateId).has(evidence.stateId))
      .map((c) => c.stateId);
    if (descendants.length) evidence.suppressedBy = descendants;
  }
  const maximal = candidates.filter(
    (c) => !candidates.some((other) => ancestors(other.stateId).has(c.stateId)),
  );
  if (
    undecidable.some((id) => !maximal.some((c) => ancestors(c.stateId).has(id)))
  )
    return result("unknown", maximal, "incomplete-competing-evidence");
  if (!maximal.length) return result("unknown");
  if (maximal.length > 1)
    return result("ambiguous", maximal, "overlapping-states");
  const candidate = maximal[0]!;
  if (
    history.stateId !== candidate.stateId ||
    history.documentEpoch !== observation.documentEpoch ||
    history.digest !== observation.digest
  ) {
    history.stateId = candidate.stateId;
    history.documentEpoch = observation.documentEpoch;
    history.digest = observation.digest;
    history.since = observation.observedAt;
    history.samples = 1;
  } else history.samples++;
  if (
    history.samples < registry.policy.stableSamples ||
    observation.observedAt - (history.since ?? observation.observedAt) <
      registry.policy.stableForMs
  )
    return {
      ...result("settling", maximal),
      stateId: candidate.stateId,
      score: candidate.score,
    };
  return {
    ...result("matched", maximal),
    stateId: candidate.stateId,
    score: candidate.score,
    actionable: registry.states[candidate.stateId]!.actionable,
  };
}

/** Reads only predicate outcomes across the selected main frame. Raw DOM values stay in-page. */
export function createPageObserver(
  page: Page,
  compiled: CompiledFlow,
): { observe(): Promise<Observation>; dispose(): void } {
  let epoch = 0;
  let sequence = 0;
  let closed = false;
  const pageId = randomUUID();
  const navigation = (frame: Frame) => {
    if (frame === page.mainFrame()) epoch++;
  };
  const close = () => {
    closed = true;
    epoch++;
  };
  page.on("framenavigated", navigation);
  page.on("close", close);
  return {
    dispose() {
      page.off("framenavigated", navigation);
      page.off("close", close);
    },
    async observe() {
      const observedAt = Date.now();
      const capturedEpoch = epoch;
      const documentEpoch = `${pageId}:${capturedEpoch}`;
      const id = randomUUID();
      const serial = ++sequence;
      const invalid = (): Observation => ({
        id,
        sequence: serial,
        documentEpoch,
        observedAt,
        completedAt: Date.now(),
        complete: false,
        blank: false,
        supported: !closed,
        evidence: {},
        digest: "",
      });
      if (closed || page.isClosed()) return invalid();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          page.evaluate(
            ({ registry, predicates, origins }) => {
              const visible = (node: Element): boolean => {
                const style = getComputedStyle(node);
                const rect = node.getBoundingClientRect();
                return (
                  style.display !== "none" &&
                  style.visibility !== "hidden" &&
                  style.visibility !== "collapse" &&
                  Number(style.opacity) !== 0 &&
                  rect.width > 0 &&
                  rect.height > 0
                );
              };
              const enabled = (node: Element): boolean =>
                !node.matches(":disabled") &&
                node.getAttribute("aria-disabled") !== "true" &&
                !node.closest("[inert]");
              const nodes = new Map<string, Element[] | null>();
              for (const [id, target] of Object.entries(registry.targets)) {
                try {
                  const found = Array.from(
                    document.querySelectorAll(target.selector),
                  );
                  nodes.set(id, found.length > 1000 ? null : found);
                } catch {
                  nodes.set(id, null);
                }
              }
              const evidence: Record<string, boolean | "unknown"> = {};
              const originRef = registry.originRefs.find(
                (alias) => origins[alias] === location.origin,
              );
              for (const predicate of predicates) {
                const key = JSON.stringify(predicate);
                if (predicate.op === "urlEquals") {
                  evidence[key] =
                    origins[predicate.originRef] === location.origin &&
                    location.pathname === predicate.pathname;
                  continue;
                }
                const found = nodes.get(predicate.target);
                const target = registry.targets[predicate.target];
                if (
                  !found ||
                  !target ||
                  (target.cardinality === "one" && found.length > 1)
                ) {
                  evidence[key] = "unknown";
                  continue;
                }
                if (predicate.op === "present") {
                  evidence[key] = found.length > 0;
                  continue;
                }
                if (predicate.op === "absent") {
                  evidence[key] = found.length === 0;
                  continue;
                }
                if (predicate.op === "visible") {
                  evidence[key] = found.some(visible);
                  continue;
                }
                if (predicate.op === "enabled") {
                  evidence[key] = found.length > 0 && found.every(enabled);
                  continue;
                }
                if (found.length !== 1) {
                  evidence[key] = found.length === 0 ? false : "unknown";
                  continue;
                }
                const node = found[0]!;
                if (predicate.op === "textEquals") {
                  const text = node.textContent || "";
                  evidence[key] =
                    text.length > 16_384
                      ? "unknown"
                      : (predicate.normalizeWhitespace
                          ? text.replace(/\s+/g, " ").trim()
                          : text) === predicate.equals;
                } else if (predicate.op === "attributeEquals")
                  evidence[key] =
                    node.getAttribute(predicate.name) === predicate.equals;
              }
              const textLength = (document.body?.innerText || "").trim().length;
              const controls = Array.from(
                document.querySelectorAll(
                  "input,button,select,textarea,a,iframe,canvas,video,img",
                ),
              )
                .slice(0, 1000)
                .filter(visible);
              const blank =
                !!document.body && textLength === 0 && controls.length === 0;
              const unsupported =
                textLength === 0 &&
                controls.length > 0 &&
                controls.every((n) => n.matches("canvas,iframe,video"));
              return {
                originRef,
                pathname: location.pathname,
                evidence,
                blank,
                supported: !unsupported,
                ready: !!document.body,
              };
            },
            {
              registry: compiled.pack.registry,
              predicates: compiled.predicates,
              origins: compiled.manifest.origins,
            },
          ),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("observation-timeout")),
              compiled.pack.registry.policy.observationTimeoutMs,
            );
          }),
        ]);
        if (epoch !== capturedEpoch || closed) return invalid();
        const evidence = result.evidence as Record<string, Truth>;
        return {
          id,
          sequence: serial,
          documentEpoch,
          observedAt,
          completedAt: Date.now(),
          originRef: result.originRef,
          pathname: result.pathname,
          complete: result.ready,
          blank: result.blank,
          supported: result.supported,
          evidence,
          digest: createHash("sha256")
            .update(JSON.stringify(evidence))
            .digest("hex"),
        };
      } catch {
        return invalid();
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}
