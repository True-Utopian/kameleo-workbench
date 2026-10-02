import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  compileFlow,
  predicateKey,
  classify,
  runFlow,
  FlowActionError,
  FlowCompileError,
  type FlowPack,
  type FlowManifest,
  type CompiledFlow,
  type Observation,
  type FlowDriver,
  type FlowJournal,
  type FlowSnapshot,
  type FlowContext,
  type RecognitionHistory,
} from "../src/flows/index.js";

const loadPack = (): FlowPack =>
  JSON.parse(
    readFileSync(
      new URL("../flows/owned-site.flow.json", import.meta.url),
      "utf8",
    ),
  );
const manifest: FlowManifest = JSON.parse(
  readFileSync(
    new URL(
      "../flows/owned-site.manifest.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const compile = () => compileFlow(loadPack(), manifest);
function observation(
  compiled: CompiledFlow,
  state: string,
  time = 1000,
  epoch = "page:1",
): Observation {
  const evidence = Object.fromEntries(
    compiled.predicates.map((p) => [predicateKey(p), false]),
  );
  const add = (id: string): void => {
    const rule = compiled.pack.registry.states[id]!;
    rule.refines?.forEach(add);
    for (const p of rule.require) evidence[predicateKey(p)] = true;
    for (const p of rule.forbid) evidence[predicateKey(p)] = false;
    for (const p of rule.support) evidence[predicateKey(p.predicate)] = true;
  };
  add(state);
  return {
    id: `${time}`,
    sequence: time,
    documentEpoch: epoch,
    observedAt: time,
    completedAt: time,
    complete: true,
    blank: false,
    supported: true,
    originRef: "owned",
    evidence,
    digest: JSON.stringify(evidence),
  };
}
function harness(compiled = compile()) {
  let time = 1_000;
  let state = "signin";
  let epoch = 1;
  let saved: FlowSnapshot | null = null;
  const snapshots: FlowSnapshot[] = [];
  const dispatches: string[] = [];
  const values = new Map<string, string>();
  const journal: FlowJournal = {
    async load() {
      return saved;
    },
    async save(snapshot) {
      saved = structuredClone(snapshot);
      snapshots.push(saved);
    },
  };
  const option = {
    key: "email",
    label: "Email code",
    type: "email",
    available: true,
    identity: "email-id",
  };
  const driver: FlowDriver = {
    async observe() {
      return observation(compiled, state, time, `page:${epoch}`);
    },
    async navigate() {
      dispatches.push("navigate");
      state = "signin";
      epoch++;
    },
    async fill(target, value, guard) {
      await guard();
      assert.equal(saved?.pending?.phase, "dispatched");
      dispatches.push(`fill:${target}`);
      values.set(target, value);
    },
    async click(target, guard) {
      await guard();
      dispatches.push(`click:${target}`);
      state = target === "signin-submit" ? "choose-method" : "account-home";
      epoch++;
    },
    async scrape(_operation, guard) {
      await guard();
      return "owned-user";
    },
    async choices() {
      return [option];
    },
    async choose(_source, _option, guard) {
      await guard();
      dispatches.push("choose:email");
      state = "enter-code";
      epoch++;
    },
  };
  const context: FlowContext = {
    runId: "run-1",
    inputs: { username: "owned-user", password: "secret-password" },
    driver,
    journal,
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
    async requestInput(_title, fields) {
      const properties = fields.properties as Record<
        string,
        { enum?: string[] }
      >;
      if (properties.decision) return { decision: "cancel" };
      return { value: properties.value?.enum?.[0] || "654321" };
    },
    identityResolvers: {
      "owned-session-receipt": {
        async bind(expected) {
          assert.equal(expected, "owned-user");
          return "secret-receipt";
        },
        async verify(receipt) {
          return receipt === "secret-receipt";
        },
      },
    },
  };
  return {
    compiled,
    context,
    driver,
    journal,
    snapshots,
    dispatches,
    values,
    option,
    get saved() {
      return saved;
    },
    setState(next: string) {
      state = next;
      epoch++;
    },
    advance(ms: number) {
      time += ms;
    },
  };
}

test("compiler validates owned flow and rejects unsafe or incomplete contracts", () => {
  assert.equal(compile().pack.id, "owned-account-signin");
  const cases: ((pack: FlowPack) => void)[] = [
    (p) => {
      p.registry.states.unknown = p.registry.states["app-shell"]!;
    },
    (p) => {
      p.registry.states["app-shell"]!.refines = ["signin"];
    },
    (p) => {
      p.start.pathname = "//unapproved.test/";
    },
    (p) => {
      p.inputSchema.required = ["password"];
    },
    (p) => {
      p.execution.proxyPolicyId = "uninstalled";
    },
    (p) => {
      p.identityPolicy = "anonymous";
    },
    (p) => {
      const step = p.steps["submit-signin"];
      if (step?.kind === "action")
        step.retry = {
          mode: "safe-repeat",
          maxAttempts: 2,
          backoffMs: 1,
          justification: "unsafe",
        };
    },
    (p) => {
      p.choices["verification-methods"]!.patterns[2]!.match = {
        keyPattern: "^sms-.$",
      };
    },
  ];
  for (const mutate of cases) {
    const pack = loadPack();
    mutate(pack);
    assert.throws(() => compileFlow(pack, manifest), FlowCompileError);
  }
});

test("specific state beats its generic ancestor only after stable fresh evidence", () => {
  const c = compile();
  const history: RecognitionHistory = { samples: 0 };
  assert.equal(
    classify(c.pack.registry, observation(c, "signin"), history, 1000).status,
    "settling",
  );
  const matched = classify(
    c.pack.registry,
    observation(c, "signin", 1150),
    history,
    1150,
  );
  assert.equal(matched.stateId, "signin");
  assert.equal(matched.actionable, true);
  assert.equal(matched.score, 1);
  assert.equal(
    matched.evidenceLog.length,
    Object.keys(c.pack.registry.states).length,
  );
  assert.deepEqual(
    matched.evidenceLog.find((e) => e.stateId === "app-shell")?.suppressedBy,
    ["signin"],
  );
  assert.equal(
    matched.evidenceLog.find((e) => e.stateId === "account-home")?.qualified,
    false,
  );
  assert.equal(
    classify(c.pack.registry, observation(c, "signin", 1150), history, 1700)
      .status,
    "invalidated",
  );
});

test("blank and incomplete observations revoke historical state authorization", () => {
  const c = compile();
  const history: RecognitionHistory = { samples: 0 };
  classify(c.pack.registry, observation(c, "signin"), history, 1000);
  classify(c.pack.registry, observation(c, "signin", 1150), history, 1150);
  const blank = classify(
    c.pack.registry,
    { ...observation(c, "signin", 1300), blank: true },
    history,
    1300,
  );
  assert.equal(blank.status, "blank");
  assert.equal(blank.stateId, undefined);
  assert.equal(blank.actionable, false);
  assert.equal(
    classify(c.pack.registry, observation(c, "signin", 1450), history, 1450)
      .status,
    "settling",
  );
  assert.equal(
    classify(
      c.pack.registry,
      { ...observation(c, "signin", 1600), complete: false },
      history,
      1600,
    ).status,
    "invalidated",
  );
});

test("incomparable overlaps abstain and unknown evidence cannot satisfy absence", () => {
  const pack = loadPack();
  pack.registry.states.duplicate = structuredClone(
    pack.registry.states.signin!,
  );
  const c = compileFlow(pack, manifest);
  const sample = observation(c, "signin");
  assert.equal(
    classify(c.pack.registry, sample, undefined, 1000).status,
    "ambiguous",
  );
  const forbidden = predicateKey(c.pack.registry.states.signin!.forbid[0]!);
  sample.evidence[forbidden] = "unknown";
  assert.equal(
    classify(c.pack.registry, sample, undefined, 1000).status,
    "unknown",
  );
});

test("full finite flow fills, prompts, chooses, binds identity and completes without journal secrets", async () => {
  const h = harness();
  const result = await runFlow(h.compiled, h.context);
  assert.equal(result.status, "completed");
  assert.equal(h.values.get("password"), "secret-password");
  assert.equal(h.values.get("code"), "654321");
  assert.deepEqual(h.dispatches, [
    "navigate",
    "fill:username",
    "fill:password",
    "click:signin-submit",
    "choose:email",
    "fill:code",
    "click:code-submit",
  ]);
  assert.equal(h.saved?.pending, undefined);
  const persisted = JSON.stringify(h.snapshots);
  for (const secret of [
    "secret-password",
    "654321",
    "secret-receipt",
    "owned-user",
  ])
    assert.ok(!persisted.includes(secret));
  assert.ok(h.snapshots.some((s) => s.pending?.phase === "intent"));
  assert.ok(h.snapshots.some((s) => s.pending?.phase === "dispatched"));
});

test("uncertain submit is journaled and never automatically replayed", async () => {
  const h = harness();
  let clicks = 0;
  h.driver.click = async (_target, guard) => {
    await guard();
    clicks++;
    throw new FlowActionError("lost-acknowledgement", true);
  };
  await assert.rejects(runFlow(h.compiled, h.context), /unresolved-action/);
  assert.equal(clicks, 1);
  assert.equal(h.saved?.pending?.phase, "uncertain");
  h.context.resume = true;
  await assert.rejects(runFlow(h.compiled, h.context), /unresolved-action/);
  assert.equal(clicks, 1);
});

test("all unavailable choices route to review without choosing", async () => {
  const h = harness();
  h.option.available = false;
  await assert.rejects(runFlow(h.compiled, h.context), /operator-cancelled/);
  assert.ok(!h.dispatches.some((d) => d.startsWith("choose")));
  assert.ok(h.snapshots.some((s) => s.stepId === "no-methods"));
});

test("choice replacement after prompt cannot substitute another option", async () => {
  const h = harness();
  const normal = h.context.requestInput;
  h.context.requestInput = async (title, fields, signal) => {
    const result = await normal(title, fields, signal);
    if ((fields.properties as Record<string, unknown>).value)
      h.option.identity += "-changed";
    return result;
  };
  await assert.rejects(runFlow(h.compiled, h.context));
  assert.ok(!h.dispatches.some((d) => d.startsWith("choose")));
});

test("journal failure prevents dispatch and pack mismatch prevents resume", async () => {
  const h = harness();
  h.journal.save = async () => {
    throw new Error("disk unavailable");
  };
  await assert.rejects(runFlow(h.compiled, h.context));
  assert.deepEqual(h.dispatches, []);
  const h2 = harness();
  await runFlow(h2.compiled, h2.context);
  const changed = loadPack();
  changed.version = "1.0.1";
  await assert.rejects(
    runFlow(compileFlow(changed, manifest), h2.context),
    /journal-mismatch/,
  );
});

test("identity resolver failure cannot complete a required pack", async () => {
  const h = harness();
  h.context.identityResolvers!["owned-session-receipt"]!.verify = async () =>
    false;
  await assert.rejects(runFlow(h.compiled, h.context), /operator-cancelled/);
  assert.notEqual(h.saved?.status, "completed");
});

test("durable handoff yields after binding before any subsequent action, then reacquires on resume", async () => {
  const pack = loadPack();
  const bind = pack.steps["bind-identity"];
  const scrape = pack.steps["scrape-account-label"];
  assert.equal(bind?.kind, "action");
  assert.equal(scrape?.kind, "action");
  if (bind?.kind !== "action" || scrape?.kind !== "action")
    throw new Error("Invalid fixture");
  pack.steps["post-bind-work"] = {
    ...structuredClone(scrape),
    next: { "account-home": "finish" },
  };
  bind.next["account-home"] = "post-bind-work";
  const h = harness(compileFlow(pack, manifest));
  let scraped = 0;
  const original = h.driver.scrape;
  h.driver.scrape = async (...args) => {
    scraped++;
    return original(...args);
  };
  h.context.afterAction = async (snapshot, operation) => {
    assert.equal(h.saved?.revision, snapshot.revision);
    assert.equal(h.saved?.pending, undefined);
    return operation.op === "bindIdentity" ? "handoff" : "continue";
  };
  const yielded = await runFlow(h.compiled, h.context);
  assert.equal(yielded.status, "handoff");
  assert.equal(yielded.snapshot.status, "running");
  assert.equal(yielded.snapshot.stepId, "post-bind-work");
  assert.equal(scraped, 1);
  h.context.resume = true;
  h.context.afterAction = async () => "continue";
  const completed = await runFlow(h.compiled, h.context);
  assert.equal(completed.status, "completed");
  assert.equal(scraped, 3);
});
