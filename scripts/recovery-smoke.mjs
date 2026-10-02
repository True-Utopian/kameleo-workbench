import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

const file = join(
  process.env.WORKBENCH_DATA_DIR || ".workbench",
  "recovery-smoke.json",
);
const base = process.env.WORKBENCH_URL || "http://127.0.0.1:3180";
async function api(path, body) {
  const response = await fetch(new URL(path, base), {
    method: body ? "POST" : "GET",
    headers: {
      authorization: `Bearer ${process.env.WORKBENCH_TOKEN}`,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`API ${path}: ${response.status}`);
  return response.json();
}
const phase = process.argv[2];
let id;
if (phase === "prepare") {
  const run = await api("/api/runs", {
    automationId: "owned-account-signin",
    inputs: {
      username: `restart-${randomUUID().slice(0, 8)}`,
      password: "test-password",
    },
  });
  id = run.id;
  await writeFile(file, JSON.stringify({ id }), { mode: 0o600 });
} else if (phase === "resume") {
  ({ id } = JSON.parse(await readFile(file, "utf8")));
  const interrupted = await api(`/api/runs/${id}`);
  assert.equal(interrupted.state, "interrupted");
  await api(`/api/runs/${id}/resume`, {});
} else throw new Error("Use prepare or resume");
const deadline = Date.now() + 120_000;
const answered = new Set();
let finished = false;
while (Date.now() < deadline) {
  const run = await api(`/api/runs/${id}`);
  if (run.challenge) {
    if (phase === "prepare") {
      console.log(
        JSON.stringify({ id, state: run.state, readyForRestart: true }),
      );
      break;
    }
    if (!answered.has(run.challenge.id)) {
      answered.add(run.challenge.id);
      const properties = run.challenge.fields.properties;
      assert.equal(
        properties.decision,
        undefined,
        "Recovered flow unexpectedly requires manual review",
      );
      await api(`/api/runs/${id}/input`, {
        challengeId: run.challenge.id,
        values: { value: properties.value.enum?.[0] ?? "123456" },
      });
    }
  }
  if (run.waitingForFinish && !finished) {
    finished = true;
    await api(`/api/runs/${id}/finish`, {});
  }
  if (run.state === "saved") {
    console.log(
      JSON.stringify({
        id,
        recovered: true,
        profileId: run.profileId,
        sha256: run.artifact.sha256,
      }),
    );
    break;
  }
  if (
    ["failed", "cancelled", "interrupted", "export_failed"].includes(run.state)
  )
    throw new Error(
      `Flow ended ${run.state}: ${run.logs
        .slice(-5)
        .map((x) => x.message)
        .join(", ")}`,
    );
  await new Promise((resolve) => setTimeout(resolve, 250));
}
if (Date.now() >= deadline) throw new Error("Recovery smoke timed out");
