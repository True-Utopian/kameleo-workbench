import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { classify, type RecognitionHistory } from "./recognition.js";
import { predicateKey } from "./compiler.js";
import { FlowActionError } from "./driver.js";
import type {
  ActionStep,
  ChoiceOption,
  CompiledFlow,
  FlowContext,
  FlowEvent,
  FlowSnapshot,
  Recognition,
  ValueRef,
} from "./types.js";

export class FlowExecutionError extends Error {
  constructor(
    public readonly code: string,
    public readonly snapshot?: FlowSnapshot,
  ) {
    super(`Flow ${code}`);
    this.name = "FlowExecutionError";
  }
}
interface Answer {
  value: string;
  epoch: string;
  stateId: string;
  expires: number;
  option?: ChoiceOption;
  source?: string;
}
interface Receipt {
  value: string;
  resolver: string;
  epoch: string;
}
export type FlowResult =
  | {
      status: "completed";
      mode: "save" | "await-operator-then-save";
      snapshot: FlowSnapshot;
    }
  | { status: "handoff"; snapshot: FlowSnapshot };

export async function runFlow(
  compiled: CompiledFlow,
  context: FlowContext,
): Promise<FlowResult> {
  const { pack } = compiled;
  const now = context.now || Date.now;
  if (!compiled.validateInputs(context.inputs))
    throw new FlowExecutionError("invalid-inputs");
  const outer = context.signal || new AbortController().signal;
  const old = await context.journal.load(context.runId);
  if (
    old &&
    (old.runId !== context.runId ||
      old.packHash !== compiled.hash ||
      old.version !== 1)
  )
    throw new FlowExecutionError("journal-mismatch");
  let snapshot: FlowSnapshot = old
    ? structuredClone(old)
    : {
        version: 1,
        runId: context.runId,
        packHash: compiled.hash,
        revision: 0,
        startedAt: now(),
        updatedAt: now(),
        status: "running",
        steps: 0,
        inputRequests: 0,
        reconciliations: 0,
        visits: {},
        attempts: {},
      };
  const deadline = snapshot.startedAt + pack.limits.maxTotalMs;
  const controller = new AbortController();
  const remaining = Math.max(0, deadline - now());
  const timer = setTimeout(() => controller.abort(), remaining);
  timer.unref();
  const signal = AbortSignal.any([outer, controller.signal]);
  const history: RecognitionHistory = { samples: 0 };
  const answers = new Map<string, Answer>();
  const captures = new Map<string, string>();
  const receipts = new Map<string, Receipt>();
  const sleep =
    context.sleep ||
    ((ms: number, s: AbortSignal) => delay(ms, undefined, { signal: s }));
  let lastState: string | undefined;
  const event = (
    type: string,
    fields: Partial<Omit<FlowEvent, "type" | "time" | "runId">> = {},
  ): FlowEvent => ({
    type,
    time: now(),
    runId: context.runId,
    stepId: snapshot.stepId,
    ...fields,
  });
  const persist = async (
    type: string,
    fields: Partial<Omit<FlowEvent, "type" | "time" | "runId">> = {},
  ) => {
    snapshot.revision++;
    snapshot.updatedAt = now();
    snapshot.lastEvent = event(type, fields);
    await context.journal.save(structuredClone(snapshot));
    context.onEvent?.(snapshot.lastEvent);
  };
  const check = async () => {
    signal.throwIfAborted();
    if (now() >= deadline)
      throw new FlowExecutionError("time-budget", snapshot);
    await context.checkpoint?.();
    signal.throwIfAborted();
  };
  const bounded = async <T>(
    operation: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
  ): Promise<T> => {
    await check();
    const timeout = new AbortController();
    const t = setTimeout(
      () => timeout.abort(),
      Math.max(1, Math.min(timeoutMs, deadline - now())),
    );
    t.unref();
    const s = AbortSignal.any([signal, timeout.signal]);
    let abort: (() => void) | undefined;
    try {
      return await Promise.race([
        operation(s),
        new Promise<never>((_, reject) => {
          abort = () =>
            reject(new FlowExecutionError("step-timeout", snapshot));
          s.addEventListener("abort", abort, { once: true });
        }),
      ]);
    } finally {
      clearTimeout(t);
      if (abort) s.removeEventListener("abort", abort);
    }
  };
  const fresh = async (): Promise<Recognition> => {
    await check();
    const observation = await bounded(
      () => context.driver.observe(),
      pack.registry.policy.observationTimeoutMs + 100,
    );
    const result = classify(pack.registry, observation, history, now());
    for (const [key, receipt] of receipts)
      if (receipt.epoch !== observation.documentEpoch) receipts.delete(key);
    const state = result.status === "matched" ? result.stateId : undefined;
    if (`${result.status}:${state}` !== lastState) {
      context.onEvent?.(
        event("recognition", {
          status: result.status,
          stateId: state,
          score: result.score,
          reason: result.reason,
          evidence: result.evidenceLog,
        }),
      );
      lastState = `${result.status}:${state}`;
    }
    return result;
  };
  const waitState = async (
    states?: string[],
    conditions: ActionStep["postcondition"]["require"] = [],
    timeoutMs = pack.registry.policy.unknownTimeoutMs,
  ): Promise<Recognition> => {
    const end = Math.min(deadline, now() + timeoutMs);
    let blankSince: number | undefined;
    while (now() < end) {
      const result = await fresh();
      if (
        result.status === "matched" &&
        result.actionable &&
        result.stateId &&
        (!states || states.includes(result.stateId)) &&
        conditions.every(
          (p) => result.observation.evidence[predicateKey(p)] === true,
        )
      )
        return result;
      if (result.status === "unsupported")
        throw new FlowExecutionError("unsupported-surface", snapshot);
      if (result.status === "blank") {
        blankSince ??= now();
        if (now() - blankSince > pack.registry.policy.blankGraceMs)
          throw new FlowExecutionError("blank-timeout", snapshot);
      } else blankSince = undefined;
      await sleep(
        Math.min(
          pack.registry.policy.sampleIntervalMs,
          Math.max(1, end - now()),
        ),
        signal,
      );
    }
    throw new FlowExecutionError("state-timeout", snapshot);
  };
  const clearDerived = () => {
    answers.clear();
    captures.clear();
    receipts.clear();
  };
  const unexpected = async (reason: string) => {
    clearDerived();
    if (pack.onUnexpected === "fail-preserve-profile")
      throw new FlowExecutionError(reason, snapshot);
    snapshot.stepId = pack.onUnexpectedStep;
    snapshot.status = "review";
    await persist("review-required", { reason });
  };
  const readValue = (ref: ValueRef, recognition: Recognition): string => {
    if (ref.source === "literal") return ref.value;
    let value: unknown;
    if (ref.source === "input") value = context.inputs[ref.key];
    else if (ref.source === "capture") value = captures.get(ref.key);
    else {
      const answer = answers.get(ref.key);
      if (
        !answer ||
        answer.epoch !== recognition.observation.documentEpoch ||
        answer.stateId !== recognition.stateId ||
        answer.expires < now()
      )
        throw new FlowActionError("stale-answer");
      value = answer.value;
    }
    if (typeof value !== "string")
      throw new FlowActionError("missing-string-value");
    return value;
  };
  const reconcile = async (
    step: ActionStep,
  ): Promise<"applied" | "not-applied" | "unknown"> => {
    if (!snapshot.pending || step.retry.mode !== "reconcile") return "unknown";
    const resolver = context.reconciliationResolvers?.[step.retry.resolver];
    if (!resolver) return "unknown";
    if (++snapshot.reconciliations > pack.limits.maxReconciliations)
      throw new FlowExecutionError("reconciliation-budget", snapshot);
    await persist("reconciliation-started", { actionId: snapshot.pending.id });
    const outcome = await bounded(
      (s) =>
        resolver(structuredClone(snapshot.pending!), {
          runId: context.runId,
          signal: s,
        }),
      step.postcondition.timeoutMs,
    );
    if (!["applied", "not-applied", "unknown"].includes(outcome))
      return "unknown";
    await persist("reconciliation-result", { reason: outcome });
    return outcome;
  };
  try {
    await check();
    if (snapshot.status === "completed")
      return { status: "completed", mode: snapshot.completionMode!, snapshot };
    if (old) {
      // Reacquire inputs and route from current evidence; ephemeral values never survive a restart.
      if (!context.resume) {
        await unexpected("resume-needs-reconciliation");
      } else if (snapshot.pending) {
        const previous = pack.steps[snapshot.pending.stepId];
        if (snapshot.pending.phase === "intent") {
          delete snapshot.pending;
          await persist("undispatched-intent-recovered");
        } else if (previous?.kind === "action") {
          const outcome = await reconcile(previous);
          if (outcome === "applied") {
            await waitState(
              previous.postcondition.states,
              previous.postcondition.require,
              previous.postcondition.timeoutMs,
            );
            delete snapshot.pending;
            await persist("action-reconciled");
          } else if (outcome === "not-applied") {
            delete snapshot.pending;
            await persist("action-not-applied");
          }
        }
        if (snapshot.pending) await unexpected("unresolved-action");
      }
      if (context.resume && !snapshot.pending && snapshot.status !== "review") {
        const state = await waitState();
        snapshot.stepId = pack.entryByState[state.stateId!];
        if (!snapshot.stepId) await unexpected("undeclared-entry");
      }
    } else {
      snapshot.pending = {
        id: randomUUID(),
        stepId: "$start",
        attempt: 1,
        phase: "intent",
      };
      await persist("navigation-intent");
      snapshot.pending.phase = "dispatched";
      await persist("navigation-dispatched");
      await bounded(
        (s) =>
          context.driver.navigate(
            new URL(
              pack.start.pathname,
              compiled.manifest.origins[pack.start.originRef],
            ).href,
            undefined,
            s,
          ),
        pack.registry.policy.unknownTimeoutMs,
      );
      delete snapshot.pending;
      await persist("navigation-observed");
      try {
        const state = await waitState();
        snapshot.stepId = pack.entryByState[state.stateId!];
        if (!snapshot.stepId) await unexpected("undeclared-entry");
      } catch (error) {
        if (signal.aborted) throw error;
        await unexpected("unrecognized-entry");
      }
    }
    while (true) {
      await check();
      if (!snapshot.stepId) await unexpected("missing-step");
      const stepId = snapshot.stepId!;
      const step = pack.steps[stepId];
      if (!step) throw new FlowExecutionError("invalid-step", snapshot);
      if (++snapshot.steps > pack.limits.maxSteps)
        throw new FlowExecutionError("step-budget", snapshot);
      snapshot.visits[stepId] = (snapshot.visits[stepId] || 0) + 1;
      if (snapshot.visits[stepId]! > pack.limits.maxStateVisits)
        throw new FlowExecutionError("visit-budget", snapshot);
      await persist("step-started");
      if (step.kind === "review") {
        snapshot.status = "review";
        clearDerived();
        await persist("review-required", { reason: step.reasonCode });
        if (++snapshot.inputRequests > pack.limits.maxInputRequests)
          throw new FlowExecutionError("input-budget", snapshot);
        await persist("review-prompted");
        const decision = await bounded(
          (s) =>
            context.requestInput(
              step.title,
              {
                type: "object",
                additionalProperties: false,
                required: ["decision"],
                properties: {
                  decision: {
                    type: "string",
                    enum: snapshot.pending
                      ? ["cancel"]
                      : ["continue", "cancel"],
                    description: snapshot.pending
                      ? "An unresolved action requires receipt reconciliation before continuing."
                      : "Continue reclassifies the current page.",
                  },
                },
              },
              s,
            ),
          step.timeoutMs,
        );
        if (decision.decision !== "continue" || snapshot.pending)
          throw new FlowExecutionError(
            snapshot.pending ? "unresolved-action" : "operator-cancelled",
            snapshot,
          );
        let state: Recognition | undefined;
        try {
          state = await waitState();
        } catch (error) {
          if (signal.aborted) throw error;
        }
        const next = state?.stateId
          ? step.recoveryByState[state.stateId]
          : step.recoveryByState.unknown;
        if (!next)
          throw new FlowExecutionError("undeclared-recovery", snapshot);
        snapshot.stepId = next;
        snapshot.status = "running";
        await persist("review-resumed");
        continue;
      }
      let recognition: Recognition;
      try {
        recognition = await waitState();
      } catch (error) {
        if (signal.aborted) throw error;
        await unexpected("required-state-unavailable");
        continue;
      }
      if (snapshot.pending) {
        await unexpected("unresolved-action");
        continue;
      }
      if (
        !recognition.stateId ||
        !step.requires.includes(recognition.stateId)
      ) {
        const recovery =
          step.kind !== "complete" && recognition.stateId
            ? step.recoveryByState[recognition.stateId]
            : undefined;
        clearDerived();
        if (recovery) {
          snapshot.stepId = recovery;
          await persist("state-recovered", { stateId: recognition.stateId });
        } else await unexpected("undeclared-state");
        continue;
      }
      if (step.kind === "complete") {
        if (pack.identityPolicy === "required" || step.identityReceipt) {
          const receipt = receipts.get(step.identityReceipt || "");
          const resolver =
            receipt && context.identityResolvers?.[receipt.resolver];
          if (
            !receipt ||
            !resolver ||
            receipt.epoch !== recognition.observation.documentEpoch ||
            !(await bounded(
              (s) =>
                resolver.verify(receipt.value, {
                  runId: context.runId,
                  signal: s,
                }),
              pack.registry.policy.unknownTimeoutMs,
            ))
          ) {
            await unexpected("identity-not-bound");
            continue;
          }
        }
        snapshot.status = "completed";
        snapshot.completionMode = step.mode;
        await persist("flow-completed", { stateId: recognition.stateId });
        clearDerived();
        return {
          status: "completed",
          mode: step.mode,
          snapshot: structuredClone(snapshot),
        };
      }
      if (step.kind === "input") {
        try {
          if (++snapshot.inputRequests > pack.limits.maxInputRequests)
            throw new FlowExecutionError("input-budget", snapshot);
          await persist("input-requested");
          const issued = now();
          const epoch = recognition.observation.documentEpoch;
          let fields: Record<string, unknown>;
          const options = new Map<string, ChoiceOption>();
          if (step.input.kind === "choice") {
            const source = pack.choices[step.input.choiceSource]!;
            const available = (await context.driver.choices(source)).filter(
              (o) => o.available,
            );
            if (!available.length) {
              snapshot.stepId = source.onAllUnavailable;
              continue;
            }
            for (const option of available)
              options.set(randomUUID(), structuredClone(option));
            fields = {
              type: "object",
              additionalProperties: false,
              required: ["value"],
              properties: {
                value: {
                  type: "string",
                  enum: [...options.keys()],
                  oneOf: [...options].map(([id, option]) => ({
                    const: id,
                    title: option.label,
                  })),
                },
              },
            };
          } else
            fields = {
              type: "object",
              additionalProperties: false,
              required: ["value"],
              properties: {
                value: {
                  type: "string",
                  minLength: step.input.minLength,
                  maxLength: step.input.maxLength,
                  writeOnly: step.input.secret,
                },
              },
            };
          const response = await bounded(
            (s) => context.requestInput(step.title, fields, s),
            step.timeoutMs,
          );
          const after = await waitState(step.requires);
          if (
            after.observation.documentEpoch !== epoch ||
            after.stateId !== recognition.stateId ||
            typeof response.value !== "string"
          )
            throw new FlowActionError("stale-answer");
          const answer: Answer = {
            value: response.value,
            epoch,
            stateId: after.stateId!,
            expires: issued + step.timeoutMs,
          };
          if (step.input.kind === "choice") {
            const source = pack.choices[step.input.choiceSource]!;
            const selected = options.get(response.value);
            if (!selected || now() > issued + source.ttlMs) {
              snapshot.stepId = source.onStale;
              continue;
            }
            const current = await context.driver.choices(source);
            if (!current.some((o) => o.available)) {
              snapshot.stepId = source.onAllUnavailable;
              continue;
            }
            if (
              !current.some(
                (o) =>
                  o.key === selected.key &&
                  o.identity === selected.identity &&
                  o.available,
              )
            ) {
              snapshot.stepId = source.onStale;
              continue;
            }
            answer.option = selected;
            answer.source = step.input.choiceSource;
            answer.expires = issued + source.ttlMs;
          } else if (
            response.value.length < step.input.minLength ||
            response.value.length > step.input.maxLength
          )
            throw new FlowActionError("invalid-answer");
          answers.set(step.answerKey, answer);
          snapshot.stepId = step.next[after.stateId!];
          await persist("input-accepted");
        } catch (error) {
          if (signal.aborted) throw error;
          clearDerived();
          snapshot.stepId =
            error instanceof FlowExecutionError &&
            error.code.includes("timeout")
              ? step.onTimeout
              : step.onError;
          await persist("input-rejected", {
            reason:
              error instanceof FlowActionError ? error.code : "input-failed",
          });
        }
        continue;
      }
      const attempt = (snapshot.attempts[stepId] || 0) + 1;
      if (attempt > step.retry.maxAttempts) {
        snapshot.stepId = step.onError;
        await persist("attempt-budget");
        continue;
      }
      snapshot.attempts[stepId] = attempt;
      snapshot.pending = { id: randomUUID(), stepId, attempt, phase: "intent" };
      await persist("action-intent", { actionId: snapshot.pending.id });
      const epoch = recognition.observation.documentEpoch;
      const guard = async () => {
        const current = await fresh();
        if (
          !current.actionable ||
          !current.stateId ||
          !step.requires.includes(current.stateId) ||
          current.observation.documentEpoch !== epoch
        )
          throw new FlowActionError("state-invalidated");
        if (snapshot.pending?.phase === "intent") {
          snapshot.pending.phase = "dispatched";
          await persist("action-dispatched", { actionId: snapshot.pending.id });
        }
      };
      let observedAction = false;
      try {
        const op = step.do;
        await bounded(async (s) => {
          if (op.op === "fill")
            await context.driver.fill(
              op.target,
              readValue(op.value, recognition),
              guard,
              s,
            );
          else if (op.op === "click")
            await context.driver.click(op.target, guard, s);
          else if (op.op === "navigate") {
            receipts.clear();
            await context.driver.navigate(
              new URL(op.pathname, compiled.manifest.origins[op.originRef])
                .href,
              guard,
              s,
            );
          } else if (op.op === "scrape")
            captures.set(
              op.outputKey,
              await context.driver.scrape(op, guard, s),
            );
          else if (op.op === "bindIdentity") {
            await guard();
            const resolver = context.identityResolvers?.[op.resolver];
            if (!resolver) throw new FlowActionError("missing-resolver");
            const receipt = await resolver.bind(
              readValue(op.expected, recognition),
              { runId: context.runId, signal: s },
            );
            if (
              typeof receipt !== "string" ||
              !receipt ||
              receipt.length > 4096
            )
              throw new FlowActionError("invalid-receipt");
            receipts.set(op.receiptKey, {
              value: receipt,
              resolver: op.resolver,
              epoch,
            });
          } else if (op.op === "chooseOption") {
            const source = pack.choices[op.choiceSource]!;
            const answer = answers.get(op.answerKey);
            if (
              !answer?.option ||
              answer.source !== op.choiceSource ||
              answer.epoch !== epoch ||
              answer.expires < now()
            )
              throw new FlowActionError("stale-choice");
            const options = await context.driver.choices(source);
            if (!options.some((o) => o.available))
              throw new FlowActionError("all-options-unavailable");
            const selected = answer.option;
            answers.delete(op.answerKey);
            await context.driver.choose(source, selected, guard, s);
          }
        }, step.postcondition.timeoutMs);
        const result = await waitState(
          step.postcondition.states,
          step.postcondition.require,
          step.postcondition.timeoutMs,
        );
        if (step.do.op === "fill" && step.do.value.source === "answer")
          answers.delete(step.do.value.key);
        const id = snapshot.pending.id;
        delete snapshot.pending;
        snapshot.stepId = step.next[result.stateId!];
        if (["wait", "scrape", "bindIdentity"].includes(step.do.op))
          delete snapshot.attempts[stepId];
        await persist("action-observed", {
          stateId: result.stateId,
          actionId: id,
        });
        observedAction = true;
      } catch (error) {
        if (signal.aborted) throw error;
        const dispatched =
          snapshot.pending?.phase !== "intent" &&
          !(error instanceof FlowActionError && !error.dispatched);
        const mutating = ["fill", "click", "chooseOption", "navigate"].includes(
          step.do.op,
        );
        const knownSafe =
          !dispatched || !mutating || step.retry.mode === "safe-repeat";
        if (knownSafe) {
          delete snapshot.pending;
          if (
            step.do.op === "chooseOption" &&
            error instanceof FlowActionError &&
            ["stale-choice", "all-options-unavailable"].includes(error.code)
          ) {
            const source = pack.choices[step.do.choiceSource]!;
            snapshot.stepId =
              error.code === "all-options-unavailable"
                ? source.onAllUnavailable
                : source.onStale;
          } else if (
            step.retry.mode === "safe-repeat" &&
            attempt < step.retry.maxAttempts
          ) {
            await persist("safe-repeat-scheduled");
            await sleep(step.retry.backoffMs, signal);
            continue;
          } else
            snapshot.stepId =
              error instanceof FlowExecutionError &&
              error.code.includes("timeout")
                ? step.onTimeout
                : step.onError;
        } else {
          snapshot.pending!.phase = "uncertain";
          await persist("action-uncertain", {
            actionId: snapshot.pending!.id,
            reason: "outcome-unconfirmed",
          });
          const outcome = await reconcile(step);
          if (outcome === "applied") {
            try {
              const result = await waitState(
                step.postcondition.states,
                step.postcondition.require,
                step.postcondition.timeoutMs,
              );
              delete snapshot.pending;
              snapshot.stepId = step.next[result.stateId!];
            } catch {
              snapshot.stepId = step.onUncertain;
            }
          } else if (outcome === "not-applied") {
            delete snapshot.pending;
            if (attempt < step.retry.maxAttempts) {
              await persist("retry-reconciled");
              await sleep(
                step.retry.mode === "never" ? 0 : step.retry.backoffMs,
                signal,
              );
              continue;
            }
            snapshot.stepId = step.onError;
          } else snapshot.stepId = step.onUncertain;
        }
        clearDerived();
        await persist("action-routed", {
          reason:
            error instanceof FlowActionError ? error.code : "action-failed",
        });
      }
      if (
        observedAction &&
        (await context.afterAction?.(structuredClone(snapshot), step.do)) ===
          "handoff"
      ) {
        clearDerived();
        return { status: "handoff", snapshot: structuredClone(snapshot) };
      }
    }
  } catch (error) {
    snapshot.status = "failed";
    if (snapshot.pending?.phase === "dispatched")
      snapshot.pending.phase = "uncertain";
    try {
      await persist("flow-stopped", {
        reason: signal.aborted
          ? "interrupted"
          : error instanceof FlowExecutionError
            ? error.code
            : "execution-failed",
      });
    } catch {
      /* A failed durable write must never allow more browser effects. */
    }
    throw error instanceof FlowExecutionError
      ? error
      : new FlowExecutionError(
          signal.aborted ? "interrupted" : "execution-failed",
          structuredClone(snapshot),
        );
  } finally {
    clearTimeout(timer);
    clearDerived();
  }
}
