import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { InputVault, bounded, durableWrite } from "../src/managed/storage.js";
import { ManagedRuntime } from "../src/managed/runtime.js";
import { prepareAssets } from "../src/assets.js";
import { createServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { fixturePolicies } from "../src/fixture.js";

test("input vault authenticates ciphertext and run identity, survives reopen, and uses private Unix files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-vault-"));
  const id = randomUUID(),
    other = randomUUID();
  const input = {
    username: "fixture-user",
    password: "fixture-private-value",
    nested: { code: "123456" },
  };
  try {
    const vault = new InputVault(directory);
    await vault.init();
    await vault.put(id, input);
    assert.deepEqual(await vault.get(id), input);
    const ciphertext = await readFile(join(directory, `${id}.sealed`));
    assert.equal(ciphertext.includes(Buffer.from(input.password)), false);
    const reopened = new InputVault(directory);
    await reopened.init();
    assert.deepEqual(await reopened.get(id), input);
    await writeFile(join(directory, `${other}.sealed`), ciphertext);
    await assert.rejects(reopened.get(other)); // Same bytes cannot be moved to another run (AAD).
    const damaged = Buffer.from(ciphertext);
    damaged[damaged.length - 1]! ^= 1;
    await writeFile(join(directory, `${id}.sealed`), damaged);
    await assert.rejects(reopened.get(id));
    await assert.rejects(vault.get("../outside"));
    if (process.platform !== "win32") {
      assert.equal((await stat(directory)).mode & 0o077, 0);
      assert.equal((await stat(join(directory, "vault-key"))).mode & 0o077, 0);
      assert.equal(
        (await stat(join(directory, `${id}.sealed`))).mode & 0o077,
        0,
      );
    }
    await vault.delete(id);
    await assert.rejects(vault.get(id), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("durable replacement publishes complete bytes with no successful-write temporary files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-durable-"));
  try {
    const file = join(directory, "private", "snapshot");
    await durableWrite(file, "first");
    await durableWrite(file, "replacement");
    assert.equal(await readFile(file, "utf8"), "replacement");
    assert.deepEqual(await readdir(join(directory, "private")), ["snapshot"]);
    if (process.platform !== "win32")
      assert.equal((await stat(file)).mode & 0o077, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("asset revisions retain prior content and repair interrupted cache writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-assets-"));
  try {
    const source = join(directory, "source"),
      cache = join(directory, "cache");
    await mkdir(source);
    await Promise.all([
      writeFile(join(source, "app.js"), "window.fixture = 1;"),
      writeFile(join(source, "styles.css"), "body{color:navy}"),
      writeFile(
        join(source, "index.html"),
        "<link href=\"/styles.css\"><script src='/app.js'></script>",
      ),
    ]);
    const first = await prepareAssets(source, cache);
    assert.match(first.html, new RegExp(`/assets/${first.revision}/app\\.js`));
    assert.match(
      first.html,
      new RegExp(`/assets/${first.revision}/styles\\.css`),
    );
    await writeFile(join(cache, first.revision, "app.js"), "partial");
    assert.equal((await prepareAssets(source, cache)).revision, first.revision);
    assert.equal(
      await readFile(join(cache, first.revision, "app.js"), "utf8"),
      "window.fixture = 1;",
    );
    await writeFile(join(source, "app.js"), "window.fixture = 2;");
    const second = await prepareAssets(source, cache);
    assert.notEqual(first.revision, second.revision);
    assert.equal(
      await readFile(join(cache, first.revision, "app.js"), "utf8"),
      "window.fixture = 1;",
    );
    assert.equal(
      await readFile(join(cache, second.revision, "app.js"), "utf8"),
      "window.fixture = 2;",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

class FixtureRuntime extends EventEmitter {
  listAutomations() {
    return [];
  }
  list() {
    return [];
  }
  get() {
    throw new Error("Missing");
  }
  submit() {
    throw new Error("Unused");
  }
  cancel() {}
  pause() {}
  resume() {}
  retryExport() {}
  done() {}
  provideInput() {}
  async screenshot() {
    return Buffer.alloc(0);
  }
}
const token = "fixture-owner-token-not-a-live-credential";
async function serverFixture(enabled = true) {
  const directory = await mkdtemp(join(tmpdir(), "workbench-managed-api-"));
  const config = await loadConfig({
    WORKBENCH_DATA_DIR: directory,
    EXPORT_DIR: directory,
    WORKBENCH_TOKEN: token,
    ENABLE_TEST_FIXTURE: String(enabled),
  });
  const app = await createServer(config, new FixtureRuntime(), {
    publicInventory: () => [],
  });
  return {
    app,
    close: async () => {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("server serves fresh HTML and immutable revisioned JavaScript; fixture is opt-in", async () => {
  const f = await serverFixture(false);
  try {
    const index = await f.app.inject("/");
    assert.equal(index.headers["cache-control"], "no-store");
    const asset = index.body.match(/\/assets\/[a-f0-9]{16}\/app\.js/)?.[0];
    assert.ok(asset);
    const script = await f.app.inject(asset);
    assert.equal(script.statusCode, 200);
    assert.match(String(script.headers["cache-control"]), /immutable/);
    assert.equal(
      script.body,
      await readFile(join(process.cwd(), "public", "app.js"), "utf8"),
    );
    assert.equal((await f.app.inject("/signin")).statusCode, 404);
  } finally {
    await f.close();
  }
});

test("owned fixture gates identity receipts on password and MFA and binds receipt to run and expected user", async () => {
  const f = await serverFixture();
  const runId = randomUUID(),
    username = "<b>fixture-user</b>";
  let cookies: Record<string, string> = {};
  const post = async (url: string, payload: Record<string, string>) => {
    const response = await f.app.inject({
      method: "POST",
      url,
      cookies,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams(payload).toString(),
    });
    for (const cookie of response.cookies) cookies[cookie.name] = cookie.value;
    return response;
  };
  try {
    assert.equal(
      (await f.app.inject(`/fixture/receipt?run=${runId}`)).statusCode,
      401,
    );
    const wrong = await post("/fixture/signin", {
      username,
      password: "wrong-private-value",
    });
    assert.match(wrong.body, /auth-error/);
    assert.doesNotMatch(wrong.body, /wrong-private-value/);
    assert.equal(
      (await post("/fixture/signin", { username, password: "test-password" }))
        .headers.location,
      "/verify/method",
    );
    assert.equal(
      (await post("/fixture/code", { code: "123456" })).headers.location,
      "/signin",
    );
    assert.equal(
      (await post("/fixture/method", { method: "authenticator" })).headers
        .location,
      "/verify/code",
    );
    assert.match(
      (await post("/fixture/code", { code: "000000" })).body,
      /auth-error/,
    );
    assert.equal(
      (await post("/fixture/code", { code: "123456" })).headers.location,
      "/account",
    );
    const account = await f.app.inject({ url: "/account", cookies });
    assert.match(account.body, /&lt;b&gt;fixture-user&lt;\/b&gt;/);
    assert.doesNotMatch(account.body, /<b>fixture-user/);
    const response = await f.app.inject({
      url: `/fixture/receipt?run=${runId}`,
      cookies,
    });
    assert.equal(response.statusCode, 200);
    const receipt = response.json().receipt as string;
    const origin = "http://fixture.example";
    const page = {
      url: () => `${origin}/account`,
      evaluate: async () => receipt,
    } as any;
    const resolver = fixturePolicies(token, origin).identities[
      "owned-session-receipt"
    ]!;
    const context = { page, runId, signal: new AbortController().signal };
    const identity = await resolver(username, context);
    assert.equal(identity.issuer, origin);
    assert.match(identity.subjectKey, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(identity).includes(username), false);
    await assert.rejects(resolver("another-user", context), /mismatch/);
    await assert.rejects(
      resolver(username, { ...context, runId: randomUUID() }),
      /mismatch/,
    );
    page.url = () => "https://unrelated.example/account";
    await assert.rejects(resolver(username, context), /origin/);
    cookies = { fixture: `${cookies.fixture}changed` };
    assert.equal(
      (await f.app.inject({ url: `/fixture/receipt?run=${runId}`, cookies }))
        .statusCode,
      401,
    );
  } finally {
    await f.close();
  }
});

function operationFixture() {
  const runtime = new ManagedRuntime({
    databaseUrl: "",
    tenantId: "tenant",
    nodeId: "node",
    teamKey: "team",
    browserBudget: 1,
    engineUrl: "http://127.0.0.1:5050",
    dataDir: ".",
    flowsDir: ".",
    localExportDir: ".",
    engineExportDir: ".",
    maxConcurrency: 1,
    runTimeoutMs: 60000,
    idleTimeoutMs: 30000,
    policies: { profiles: {}, proxies: {}, identities: {} },
    database: {} as any,
    engine: {} as any,
  });
  const events: string[] = [];
  Object.assign(runtime.coordinator, {
    beginOperation: async () => ({ id: "operation", sequence: 1 }),
    reserveRequest: async () => ({
      id: "reservation",
      notBefore: new Date().toISOString(),
      dispatchBefore: new Date(Date.now() + 500).toISOString(),
    }),
    markRequestDispatched: async () => {},
    providerBackoff: async () => {},
    markDispatched: async () => {
      events.push("dispatched");
    },
    resolveOperation: async (
      _grant: unknown,
      _id: string,
      result: { outcome?: string; state?: string },
    ) => {
      events.push(result.outcome ?? result.state!);
    },
    markOperationUnknown: async () => {
      events.push("unknown");
    },
  });
  const session = {
    grant: { id: "lease", flowId: "run" },
    abort: new AbortController(),
    deadline: Infinity,
    sequence: 0,
    stopped: false,
    uncertain: false,
    lastProgress: 0,
  };
  return { runtime: runtime as any, session, events };
}

test(
  "a timed-out remote operation stays uncertain after late success and cannot claim a stop",
  { timeout: 3000 },
  async () => {
    const { runtime, session, events } = operationFixture();
    let resolve!: (value: { id: string }) => void;
    const remote = new Promise<{ id: string }>((r) => {
      resolve = r;
    });
    const keepAlive = setTimeout(() => {}, 1000);
    try {
      await assert.rejects(
        runtime.operation(session, "create", () => remote, 15),
        /timeout/i,
      );
      assert.equal(session.uncertain, true);
      assert.deepEqual(events, ["dispatched", "unknown"]);
      resolve({ id: "late-profile" });
      await delay(0);
      assert.deepEqual(events, ["dispatched", "unknown", "succeeded"]);
      assert.equal(session.uncertain, true);
      await assert.rejects(runtime.stop(session), /Unresolved/);
    } finally {
      clearTimeout(keepAlive);
    }
  },
);

test("known vendor rejection is settled; transport failures remain uncertain", async () => {
  const known = operationFixture();
  await assert.rejects(
    known.runtime.operation(known.session, "create", async () => {
      throw Object.assign(new Error("rejected"), { status: 429 });
    }),
  );
  assert.equal(known.session.uncertain, false);
  assert.deepEqual(known.events, ["dispatched", "rejected"]);
  const lost = operationFixture();
  await assert.rejects(
    lost.runtime.operation(lost.session, "start", async () => {
      throw new Error("Connection closed");
    }),
  );
  assert.equal(lost.session.uncertain, true);
  assert.deepEqual(lost.events, ["dispatched", "unknown"]);
});

test("input challenge is removed when persistence fails and submitted input cannot strand its waiter", async () => {
  for (const failAt of ["awaiting_input", "running"]) {
    const { runtime, session } = operationFixture();
    runtime.sessions.set("run", session);
    runtime.records.set("run", { id: "run", state: "running" });
    runtime.status = async (_id: string, state: string) => {
      if (state === failAt) throw new Error("Database unavailable");
    };
    const waiting = runtime.ask("run", "Fixture code", {
      type: "object",
      properties: { code: { type: "string" } },
      required: ["code"],
      additionalProperties: false,
    });
    const rejected = assert.rejects(
      waiting,
      failAt === "awaiting_input" ? /Database/ : /committed/,
    );
    if (failAt === "running") {
      const challengeId = runtime.records.get("run").challenge.id;
      await assert.rejects(
        runtime.provideInput("run", challengeId, { code: "123456" }),
        /Database/,
      );
    }
    await rejected;
    assert.equal(session.input, undefined);
    assert.equal(runtime.records.get("run").challenge, undefined);
  }
});

test("bounded abort rejects immediately without claiming cancellation of the underlying work", async () => {
  const controller = new AbortController();
  let resolve!: (value: string) => void;
  const operation = new Promise<string>((r) => {
    resolve = r;
  });
  const outer = bounded(operation, 1000, controller.signal);
  controller.abort(new Error("test cancellation"));
  await assert.rejects(outer, /test cancellation/);
  resolve("late remote result");
  assert.equal(await operation, "late remote result");
});

test("recovery exposes durable page state and expires only inactive input envelopes", async () => {
  const { runtime } = operationFixture();
  const expired = randomUUID(), active = randomUUID(), removed: string[] = [];
  const make = (id: string) => ({ id, pack: { key: 'fixture' }, state: 'interrupted', metadata: {}, checkpoint: { stepId: 'ask-code', lastEvent: { stateId: 'enter-code' } }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() - 1000).toISOString() });
  runtime.coordinator.listFlows = async () => [make(expired), make(active)];
  runtime.vault = { delete: async (id: string) => { removed.push(id); } };
  runtime.sessions.set(active, {});
  await runtime.refresh(); await runtime.refresh();
  assert.deepEqual(removed, [expired]);
  assert.equal(runtime.get(expired).managed, true);
  assert.equal(runtime.get(expired).flowState, 'enter-code');
  runtime.work.set(expired, Promise.resolve());
  runtime.cache({ ...make(expired), state: 'review', waitReason: 'switch_pending' });
  assert.equal(runtime.get(expired).state, 'starting');
});
