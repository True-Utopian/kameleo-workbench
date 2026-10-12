#!/usr/bin/env node
import { readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { Runtime } from './runtime.js';
import { ProxyManager } from './proxies/index.js';
import { createServer } from './server.js';
import { ManagedRuntime } from './managed/runtime.js';
import { durableWrite, stableId } from './managed/storage.js';
import { fixturePolicies } from './fixture.js';
import type { FlowPolicies } from './managed/policies.js';
import { KameleoEngine } from './engine.js';
import { LocalEngine, VesperBrowserClient, isLocalEngine } from './local-engine.js';
import { LocalDatabase } from './coordinator/local-database.js';
import { CombinedRuntime } from './combined-runtime.js';
import { resolveLocalIdentity } from './coordinator/local-identity.js';

async function main() {
  const command = process.argv[2] ?? 'serve';
  if (['help', '--help', '-h'].includes(command)) {
    console.log(`Vesper Workbench by true-utopian\n\n  serve                  Start the authenticated workbench\n  token                  Print this instance's access token\n  doctor                 Check the selected browser backend\n  browser-install        Install free Chromium for the local backend\n  profile-list           List local profiles (service must be stopped)\n  profile-import <file>   Restore a local .workbench.tgz archive\n  profile-export <id> <file>  Export a stopped local profile\n  list                   List automation modules\n  run <id> <inputs.json>  Submit to the running workbench\n\nConfiguration: .env / environment variables; see docs/local-browser.md.\nUse '-' instead of an inputs file to read JSON from stdin.`);
    return;
  }
  const config = await loadConfig();
  if (command === 'token') { console.log(config.token); return; }
  const engine = config.browserBackend === 'local'
    ? (config.vesperBrowserUrl ? new VesperBrowserClient({ url: config.vesperBrowserUrl, tokenFile: config.vesperBrowserTokenFile! }) : new LocalEngine({ directory: config.localBrowserDir, executablePath: config.localBrowserExecutable, headless: config.localBrowserHeadless, buildId: config.localBrowserBuildId, maxConcurrency: config.maxConcurrency }))
    : new KameleoEngine(config.engineUrl);
  // Desktop ports are ephemeral; coordination identity follows the persistent store.
  const localOwner = config.vesperBrowserTokenFile ? dirname(config.vesperBrowserTokenFile) : config.localBrowserDir;
  if (command === 'browser-install' || command.startsWith('profile-')) {
    if (!isLocalEngine(engine)) throw new Error('This command requires BROWSER_BACKEND=local.');
    try {
      if (command === 'browser-install') console.log(`Chromium installed: ${await engine.installBrowser()}`);
      else if (command === 'profile-list') console.log(JSON.stringify(await engine.listProfiles(), null, 2));
      else if (command === 'profile-import' && process.argv[3]) console.log(JSON.stringify(await engine.importProfile(resolve(process.argv[3]))));
      else if (command === 'profile-export' && process.argv[3] && process.argv[4]) { await engine.export(process.argv[3], resolve(process.argv[4])); console.log('Profile exported.'); }
      else throw new Error('Invalid profile command. Use --help.');
    } finally { await engine.close(); }
    return;
  }
  if (command === 'doctor') {
    if (isLocalEngine(engine)) {
      const response = await fetch(`${process.env.WORKBENCH_URL ?? `http://127.0.0.1:${config.port}`}/api/status`, { headers: { authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(2500) }).catch(() => undefined);
      if (response?.ok) {
        const status = await response.json() as { engine: { backend: string; ready: boolean; error?: string } };
        if (status.engine.backend === 'local') { console.log(status.engine.ready ? 'Vesper Browser ready (running workbench).' : status.engine.error); process.exitCode = status.engine.ready ? 0 : 1; return; }
      }
    }
    try { await engine.ready(); console.log(`${engine.kind} browser backend ready.`); }
    finally { if (isLocalEngine(engine)) await engine.close(); }
    return;
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
  let runtime: Runtime | ManagedRuntime | CombinedRuntime;
  if (config.databaseUrl || config.localCoordinator) {
    if (!config.teamKey && config.browserBackend === 'kameleo') throw new Error('KAMELEO_TEAM_KEY is required with DATABASE_URL. Use the same team key on every install sharing the provider cap.');
    let nodeId = config.nodeId || undefined;
    if (!nodeId) {
      const file = join(config.dataDir, 'node-id');
      try { nodeId = (await readFile(file, 'utf8')).trim(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; nodeId = randomUUID(); await durableWrite(file, nodeId); }
    }
    let policies: FlowPolicies = { profiles: { 'local-profile': () => ({ storage: 'local' }), 'local-brave': () => ({ storage: 'local', engine: 'brave' }) }, proxies: { 'local-direct': () => undefined }, identities: {} };
    if (config.enableTestFixture && config.fixtureOrigin) { const fixture = fixturePolicies(config.token, config.fixtureOrigin); policies = { profiles: { ...policies.profiles, ...fixture.profiles, 'owned-fixture-brave':()=>({storage:'local',engine:'brave'}) }, proxies: { ...policies.proxies, ...fixture.proxies }, identities: fixture.identities }; }
    if (config.flowPoliciesFile) {
      const loaded = await import(pathToFileURL(resolve(config.flowPoliciesFile)).href);
      const custom = loaded.default as FlowPolicies;
      policies = { profiles: { ...policies.profiles, ...custom.profiles }, proxies: { ...policies.proxies, ...custom.proxies }, identities: { ...policies.identities, ...custom.identities } };
    }
    const database = config.localCoordinator && !config.databaseUrl ? await LocalDatabase.open(join(config.dataDir, 'coordinator/database')) : undefined;
    let identity;
    try { if (database && config.browserBackend === 'local') { if (!config.vesperBrowserUrl && isLocalEngine(engine)) await engine.listProfiles(); identity = await resolveLocalIdentity({ database, dataDir: config.dataDir, nodeId, browserOwner: localOwner, tenantId: config.tenantId, teamKey: config.teamKey }); } }
    catch (error) { await database?.close(); throw error; }
    const managed = new ManagedRuntime({ ...config, dataDir: database ? join(config.dataDir, 'flow-state') : config.dataDir, database, engine, engineExportDir: config.browserBackend === 'local' ? config.localExportDir : config.engineExportDir, databaseUrl: config.databaseUrl ?? 'local:pglite', tenantId: identity?.tenantId || config.tenantId || stableId(config.browserBackend === 'local' ? `workbench:local:${localOwner}` : 'workbench:default-tenant'), nodeId, teamKey: identity?.teamKey || config.teamKey || `local:${localOwner}`, browserBudget: config.browserBudget!, flowsDir: config.flowsDir!, idleTimeoutMs: config.idleTimeoutMs!, policies, proxies });
    runtime = database ? new CombinedRuntime(new Runtime({ ...config, dataDir: join(config.dataDir, 'script-state'), engine, proxies, engineExportDir: config.localExportDir }), managed) : managed;
  } else runtime = new Runtime({ ...config, engine, proxies, defaultProxyRequest: config.defaultProxyInventoryIds.length ? { provider: 'inventory', inventoryIds: config.defaultProxyInventoryIds } : undefined, engineExportDir: config.browserBackend === 'local' ? config.localExportDir : config.engineExportDir });
  await runtime.init();
  if (command === 'list') { console.log(JSON.stringify(runtime.listAutomations(), null, 2)); await runtime.close(); if (isLocalEngine(engine)) await engine.close(); return; }
  if (command !== 'serve') { await runtime.close(); throw new Error('Unknown command. Use --help.'); }
  const app = await createServer(config, runtime, { publicInventory: () => proxies.publicInventory(), check: id => proxies.probeInventory(id) }, engine);
  await app.listen({ host: config.host, port: config.port });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  const instance = randomUUID();
  await durableWrite(join(config.dataDir, 'service.json'), JSON.stringify({ version: 1, product: 'Vesper Workbench', apiVersion: '1.0', pid: process.pid, port, instance }));
  process.send?.({ type: 'ready', port, product: 'Vesper Workbench' });
  console.log(`Vesper Workbench by true-utopian listening on ${config.host}:${port}`);
  console.log('Use "node dist/cli.js token" to display the access token.');
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    await app.close(); await runtime.close(); if (isLocalEngine(engine)) await engine.close();
    const descriptor = join(config.dataDir, 'service.json');
    const current = JSON.parse(await readFile(descriptor, 'utf8').catch(() => '{}'));
    if (current.instance === instance) await rm(descriptor, { force: true });
  })();
  process.once('SIGINT', () => { void close(); });
  process.once('SIGTERM', () => { void close(); });
  process.on('message', message => { if (message === 'shutdown') void close().then(() => {if(process.connected)process.disconnect?.();}).catch(()=>{console.error('Workbench shutdown failed.');process.exitCode=1;}); });
  process.once('disconnect', () => { void close(); });
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Workbench failed.'); process.exitCode = 1; });
