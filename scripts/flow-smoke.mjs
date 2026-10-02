import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

const base = process.env.WORKBENCH_URL || "http://127.0.0.1:3180";
const token = process.env.WORKBENCH_TOKEN;
if (!token) throw new Error("WORKBENCH_TOKEN is required");
async function api(path, body) {
  const response = await fetch(new URL(path, base), {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`API ${path} returned ${response.status}`);
  return response.json();
}
const username = `fixture-${randomUUID().slice(0, 8)}`;
async function run(identityId) {
  const submitted = await api("/api/runs", {
    automationId: "owned-account-signin",
    inputs: { username, password: "test-password" },
    preset: "fast",
    ...(identityId ? { identityId } : {}),
  });
  const deadline = Date.now() + 240_000,
    answered = new Set();
  let done = false;
  while (Date.now() < deadline) {
    const state = await api(`/api/runs/${submitted.id}`);
    if (state.challenge && !answered.has(state.challenge.id)) {
      const properties = state.challenge.fields.properties;
      if (properties.decision)
        throw new Error(
          `Flow requested review: ${state.logs
            .slice(-4)
            .map((x) => x.message)
            .join(", ")}`,
        );
      const field = properties.value;
      const value = field.enum
        ? (field.enum.find(
            (x) => typeof x === "string" && x.includes("authenticator"),
          ) ?? field.enum[0])
        : "123456";
      answered.add(state.challenge.id);
      await api(`/api/runs/${state.id}/input`, {
        challengeId: state.challenge.id,
        values: { value },
      });
    }
    if (state.waitingForFinish && !done) {
      done = true;
      await api(`/api/runs/${state.id}/finish`, {});
    }
    if (state.state === "saved") {
      assert.ok(state.identityId);
      assert.ok(state.artifact?.sha256);
      const response = await fetch(
        new URL(`/api/runs/${state.id}/artifact`, base),
        {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(30_000),
        },
      );
      assert.equal(response.status, 200);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(
        createHash("sha256").update(bytes).digest("hex"),
        state.artifact.sha256,
      );
      console.log(
        JSON.stringify({
          runId: state.id,
          profileId: state.profileId,
          identityId: state.identityId,
          bytes: bytes.length,
          sha256: state.artifact.sha256,
          elapsedMs: Date.now() - Date.parse(submitted.createdAt),
        }),
      );
      return state;
    }
    if (
      ["failed", "cancelled", "interrupted", "export_failed"].includes(
        state.state,
      )
    )
      throw new Error(
        `Flow ${state.id} ended ${state.state}: ${state.waitReason}; ${state.logs
          .slice(-5)
          .map((x) => x.message)
          .join(", ")}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Flow ${submitted.id} timed out`);
}
const cold = await run();
const warm = await run(cold.identityId);
assert.equal(warm.profileId, cold.profileId);
const rebound = await run();
assert.equal(rebound.profileId, cold.profileId);
console.log(
  "Flow smoke passed: cold login, warm reuse, duplicate identity handoff, verified exports.",
);
