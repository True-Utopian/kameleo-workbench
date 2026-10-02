#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { Runtime } from './runtime.js';
import { ProxyManager } from './proxies/index.js';
import { createServer } from './server.js';
import { ManagedRuntime } from './managed/runtime.js';
import { durableWrite, stableId } from './managed/storage.js';
import { fixturePolicies } from './fixture.js';
import type { FlowPolicies } from './managed/policies.js';

async function main() {
  const command = process.argv[2] ?? 'serve';
  if (['help', '--help', '-h'].includes(command)) {
    console.log(`Kameleo Workbench\n\n  serve                  Start the authenticated workbench\n  token                  Print this instance's access token\n  doctor                 Check engine connectivity\n  list                   List automation modules\n  run <id> <inputs.json>  Submit to the running workbench\n\nConfiguration: .env / environment variables; see docs/deployment.md.\nUse '-' instead of an inputs file to read JSON from stdin.`);
    return;
  }
  const config = await loadConfig();
  if (command === 'token') { console.log(config.token); return; }
  if (command === 'doctor') {
    const result = await fetch(`${config.engineUrl}/general/healthcheck`, { signal: AbortSignal.timeout(5000) });
    console.log(result.ok ? 'Engine ready.' : `Engine not ready (HTTP ${result.status}).`);
    process.exitCode = result.ok ? 0 : 1; return;
  }
  if (command === 'run') {
    const automationId = process.argv[3]; const file = process.argv[4];
    if (!automationId || !file) throw new Error('Usage: run <automation-id> <inputs.json|->');
    let raw: string;
    if (file === '-') { const chunks: Buffer[] = []; for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk)); raw = Buffer.concat(chunks).toString('utf8'); }
    else raw = await readFile(file, 'utf8');
    const inputs = JSON.parse(raw);
    const url = process.env.WORKBENCH_URL ?? `http://127.0.0.1:${config.port}`;
    const result = await fetch(`${url}/api/runs`, { method: 'POST', headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ automationId, inputs }), signal: AbortSignal.timeout(15000) });
    if (!result.ok) throw new Error(`Submission failed (HTTP ${result.status}).`);
    const run = await result.json() as { id: string; state: string };
    console.log(JSON.stringify({ id: run.id, state: run.state }, null, 2)); return;
  }
  const proxies = new ProxyManager({ inventoryFile: config.inventoryFile });
  let runtime: Runtime | ManagedRuntime;
  if (config.databaseUrl) {
    if (!config.teamKey) throw new Error('KAMELEO_TEAM_KEY is required with DATABASE_URL. Use the same team key on every install sharing the provider cap.');
    let nodeId = config.nodeId || undefined;
    if (!nodeId) {
      const file = join(config.dataDir, 'node-id');
      try { nodeId = (await readFile(file, 'utf8')).trim(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; nodeId = randomUUID(); await durableWrite(file, nodeId); }
    }
    let policies: FlowPolicies = { profiles: {}, proxies: {}, identities: {} };
    if (config.enableTestFixture && config.fixtureOrigin) policies = fixturePolicies(config.token, config.fixtureOrigin);
    if (config.flowPoliciesFile) {
      const loaded = await import(pathToFileURL(resolve(config.flowPoliciesFile)).href);
      const custom = loaded.default as FlowPolicies;
      policies = { profiles: { ...policies.profiles, ...custom.profiles }, proxies: { ...policies.proxies, ...custom.proxies }, identities: { ...policies.identities, ...custom.identities } };
    }
    runtime = new ManagedRuntime({ ...config, databaseUrl: config.databaseUrl, tenantId: config.tenantId || stableId('workbench:default-tenant'), nodeId, teamKey: config.teamKey, browserBudget: config.browserBudget!, flowsDir: config.flowsDir!, idleTimeoutMs: config.idleTimeoutMs!, policies, proxies });
  } else runtime = new Runtime({ ...config, proxies });
  await runtime.init();
  if (command === 'list') { console.log(JSON.stringify(runtime.listAutomations(), null, 2)); await runtime.close(); return; }
  if (command !== 'serve') { await runtime.close(); throw new Error('Unknown command. Use --help.'); }
  const app = await createServer(config, runtime, { publicInventory: () => proxies.publicInventory(), check: id => proxies.probeInventory(id) });
  await app.listen({ host: config.host, port: config.port });
  console.log(`Kameleo Workbench listening on ${config.host}:${config.port}`);
  console.log('Use "node dist/cli.js token" to display the access token.');
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await runtime.close(); await app.close(); };
  process.once('SIGINT', () => { void close(); });
  process.once('SIGTERM', () => { void close(); });
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Workbench failed.'); process.exitCode = 1; });
