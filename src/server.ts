import { vesperWorkbenchVersion } from './version.js';
import Fastify, { type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import websocket from '@fastify/websocket';
import { WebSocket } from 'ws';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, realpath, rm } from 'node:fs/promises';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerResponse } from 'node:http';
import { AccessControl } from './auth.js';
import type { Config } from './config.js';
import type { PacePreset } from './actions.js';
import { registerFixture } from './fixture.js';
import { prepareAssets } from './assets.js';
import type { EngineAdapter } from './engine.js';
import { isLocalEngine } from './local-engine.js';
import { randomUUID } from 'node:crypto';
import swagger from '@fastify/swagger';
import { AdmissionJournal } from '@true-utopian/vesper-browser';
import { Scheduler } from './scheduler.js';
import { calendarOccurrences } from './calendar.js';
import { FlowLibrary, type FlowPublisher } from './flow-library.js';
import type { FlowPack, FlowManifest } from './flows/types.js';

// The interface makes API tests independent of a running, licensed engine.
export interface WorkbenchRuntime extends FlowPublisher {
  listAutomations(): unknown;
  submit(input: { automationId: string; inputs: Record<string, unknown>; preset?: PacePreset; identityId?: string }): unknown;
  list(): any[];
  get(id: string): any;
  cancel(id: string): unknown; pause(id: string): unknown; resume(id: string): unknown;
  retryExport(id: string): unknown; done(id: string): unknown;
  provideInput(id: string, challengeId: string, values: Record<string, unknown>): unknown;
  screenshot(id: string): Promise<Buffer>;
  evidence?(id: string): Promise<unknown>;
  stats?(): Promise<unknown>;
  on(event: string, fn: (...args: any[]) => void): unknown;
  off(event: string, fn: (...args: any[]) => void): unknown;
}
export interface WorkbenchProxies { publicInventory(): unknown; check?(id: string): Promise<unknown> }
const activeStates = new Set(['running', 'paused', 'awaiting_input']);
const canControl = (run: any) => run && activeStates.has(run.state) && (run.state === 'paused' || run.state === 'awaiting_input' || run.waitingForFinish === true);
const paceSchema = { anyOf: [
  { enum: ['fast', 'natural', 'natural-fast'] },
  { type: 'object', additionalProperties: false, properties: Object.fromEntries(['typingDelayMs', 'typingJitterMs', 'actionDelayMs', 'actionJitterMs', 'pointerDurationMs', 'clickDelayMs'].map(key => [key, { type: 'number', minimum: 0, maximum: 10000 }]).concat([['pointerSteps', { type: 'integer', minimum: 1, maximum: 100 }]])) },
] };
function httpError(statusCode: number, message: string) { return Object.assign(new Error(message), { statusCode }); }

export async function createServer(config: Config, runtime: WorkbenchRuntime, proxies: WorkbenchProxies, engine?: EngineAdapter) {
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024, trustProxy: false });
  const access = new AccessControl(config.token);
  const admissions = new AdmissionJournal(path.join(config.dataDir, 'admissions'));
  const scheduler = new Scheduler(path.join(config.dataDir, 'scheduler'), runtime);
  const flowLibrary = new FlowLibrary(path.join(config.dataDir,'flow-library'),runtime);
  await scheduler.init();
  app.addHook('onClose', () => scheduler.close());
  await app.register(swagger, { openapi: { info: { title: 'Vesper Workbench by true-utopian', version: '1.0.0' }, components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } }, security: [{ bearer: [] }] } });
  app.addHook('onRoute', route => {
    if (route.url?.startsWith('/api/') && !route.url.startsWith('/api/v1/') && route.method !== 'HEAD') {
      app.route({ ...route, url: route.url.replace(/^\/api\//, '/api/v1/') });
    }
  });
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const assets = await prepareAssets(path.join(root, 'public'), path.join(config.dataDir, 'assets'));
  const viewers = new Map<WebSocket, { id: string; session?: string; bearer?: string }>();
  const streams = new Map<ServerResponse, { session?: string; close: () => void }>();
  await app.register(cookie);
  if (config.enableTestFixture) await registerFixture(app, config.token);
  await app.register(websocket, { options: { maxPayload: 2 * 1024 * 1024 } });
  const authenticate = (request: FastifyRequest) => {
    const header = request.headers.authorization;
    return (header?.startsWith('Bearer ') && access.matches(header.slice(7))) || access.valid(request.cookies.workbench);
  };
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cache-Control', 'no-store');
    reply.header('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; frame-ancestors 'self' ${config.embedOrigins.join(' ')}; base-uri 'none'; form-action 'self'`);
    if (!request.url.startsWith('/api/')) return;
    // Check WebSocket upgrades too: cookies must not authorize an unrelated site.
    const origin = request.headers.origin;
    const expectedOrigin = config.publicOrigin ?? `${request.protocol}://${request.host}`;
    if (origin && origin !== expectedOrigin) throw httpError(403, 'Origin is not allowed.');
    if (request.url.split('?')[0]!.replace(/^\/api\/v1\//, '/api/') === '/api/login') return;
    if (!authenticate(request)) throw httpError(401, 'Sign in to the workbench.');
  });
  app.setErrorHandler((error, _request, reply) => {
    const status = Number((error as any).statusCode ?? 500);
    // Upstream exceptions can include request bodies, proxy credentials or URLs.
    reply.code(status >= 400 && status <= 599 ? status : 500).send({ error: status < 500 && error instanceof Error ? error.message : 'The operation failed. Check the run state or engine availability.' });
  });
  app.get('/healthz', async () => ({ ok: true }));
  app.get('/api/capabilities', async () => ({ product: 'Vesper Workbench', author: 'true-utopian', version: vesperWorkbenchVersion, apiVersion: '1.0', capabilities: { scripts: true, schedules:true, calendarSchedules:{cronFields:5,timezones:true,preview:true,missedRuns:"coalesce"}, scheduleRecovery:'quarantine-uncertain-admission', flowEditor:!!runtime.installFlow, immutablePublishedRuns:true, flows: !!(config.databaseUrl || config.localCoordinator), localCoordinator: !!config.localCoordinator, idempotentAdmission: true, runControls: true, evidence: true, screenshots: true, archives: true, events: 'sse', browserService: !!config.vesperBrowserUrl } }));
  app.get('/api/openapi.json', async () => app.swagger());
  app.get('/api/schedules', async () => scheduler.list());
  app.post<{ Body: Record<string, unknown> }>('/api/schedules', { schema: { body: { type: 'object', required: ['name','automationId','inputs'], additionalProperties: false, properties: { name: { type: 'string', minLength: 1, maxLength: 120 }, automationId: { type: 'string' }, inputs: { type: 'object' }, nextAt: { type: 'integer', minimum: 0 }, intervalMs: { type: 'integer', minimum: 60000, maximum: 31536000000 },cron:{type:'string',minLength:1,maxLength:160},timezone:{type:'string',minLength:1,maxLength:120} } } } }, request => scheduler.create(request.body));
  app.post<{Body:{cron:string;timezone?:string;after?:number}}>('/api/schedules/preview',{schema:{body:{type:'object',required:['cron'],additionalProperties:false,properties:{cron:{type:'string',minLength:1,maxLength:160},timezone:{type:'string',minLength:1,maxLength:120},after:{type:'integer',minimum:0,maximum:8639999999999999}}}}},request=>({occurrences:calendarOccurrences(request.body.cron,request.body.timezone??'UTC',request.body.after??Date.now())}));
  for (const action of ['pause','resume','remove'] as const) app.post<{ Params: { id: string } }>(`/api/schedules/:id/${action}`, request => scheduler.control(request.params.id, action));
  app.get('/api/flow-library', async () => ({...await flowLibrary.list(),defaults:{origin:config.fixtureOrigin,fixture:!!config.fixtureOrigin}}));
  app.post<{ Body: { pack: FlowPack; manifest: FlowManifest; revision: number; layout?: Record<string,{x:number;y:number}> } }>('/api/flow-library', { schema: { body: { type: 'object', required: ['pack','manifest','revision'], additionalProperties: false, properties: { pack: { type: 'object' }, manifest: { type: 'object' }, revision: { type: 'integer', minimum: 0 }, layout: {type:'object',additionalProperties:{type:'object',required:['x','y'],additionalProperties:false,properties:{x:{type:'number',minimum:0,maximum:10000},y:{type:'number',minimum:0,maximum:10000}}}} } } } }, async request => {
    try { return await flowLibrary.save(request.body.pack,request.body.manifest,request.body.revision,request.body.layout); }
    catch (error) { if ((error as Error).name === 'FlowCompileError') throw httpError(400,(error as Error).message); throw error; }
  });
  app.post<{ Params: { id: string }; Body: { revision: number } }>('/api/flow-library/:id/publish', { schema: { body: { type: 'object', required: ['revision'], additionalProperties: false, properties: { revision: { type: 'integer', minimum: 1 } } } } }, request => flowLibrary.publish(request.params.id,request.body.revision));
  app.post<{ Body: { token: string } }>('/api/login', {
    schema: { body: { type: 'object', required: ['token'], additionalProperties: false, properties: { token: { type: 'string', maxLength: 512 } } } },
  }, async (request, reply) => {
    const id = access.login(request.body.token, request.ip);
    reply.setCookie('workbench', id, { path: '/', httpOnly: true, sameSite: 'strict', secure: config.secureCookie, maxAge: 43200 });
    return { authenticated: true };
  });
  app.get('/api/session', async () => ({ authenticated: true }));
  app.post('/api/logout', async (request, reply) => {
    access.logout(request.cookies.workbench);
    const session = request.cookies.workbench;
    if (session) {
      for (const [socket, viewer] of viewers) if (viewer.session === session) socket.close(1000, 'Signed out');
      for (const stream of streams.values()) if (stream.session === session) stream.close();
    }
    reply.clearCookie('workbench', { path: '/' });
    return { authenticated: false };
  });
  app.get('/api/status', async () => {
    let ready = false;
    try {
      if (engine) { await engine.ready(); ready = true; }
      else ready = (await fetch(`${config.engineUrl}/general/healthcheck`, { signal: AbortSignal.timeout(2500) })).ok;
    } catch {}
    const runs = runtime.list();
    return { engine: { ready, backend: engine?.kind ?? 'kameleo', ...(config.vesperBrowserUrl ? { managerUrl: config.vesperBrowserUrl } : {}), ...(!ready ? { error: config.vesperBrowserUrl ? 'Vesper Browser service is unavailable. Start Browser and check its access token file.' : engine?.kind === 'local' ? 'Local Chromium is unavailable. Run npm run browser:install while the service is stopped, or configure LOCAL_BROWSER_EXECUTABLE.' : 'Engine is not ready.' } : {}) }, config: { maxConcurrency: config.maxConcurrency }, coordinator: runtime.stats ? await runtime.stats() : undefined, stats: { total: runs.length, active: runs.filter(run => activeStates.has(run.state)).length, saved: runs.filter(run => run.state === 'saved').length, cleanupRequired: runs.filter(run => run.cleanupRequired && ['failed', 'cancelled', 'interrupted', 'export_failed'].includes(run.state)).length } };
  });
  if (isLocalEngine(engine)) {
    app.addContentTypeParser('application/gzip', (_request, stream, done) => done(null, stream));
    const unowned = (id: string) => {
      if (runtime.list().some(run => run.profileId === id && (['starting', 'running', 'awaiting_input', 'paused', 'saving'].includes(run.state) || run.cleanupRequired))) throw httpError(409, 'This profile belongs to an active run. Use its run controls.');
    };
    app.get('/api/local-profiles', async () => engine.listProfiles());
    app.post<{ Body: Readable }>('/api/local-profiles/import', async (request, reply) => {
      if (request.headers['content-type']?.split(';')[0] !== 'application/gzip') throw httpError(415, 'Upload a .workbench.tgz archive as application/gzip.');
      const directory = path.join(config.dataDir, 'imports'); await mkdir(directory, { recursive: true, mode: 0o700 });
      const file = path.join(directory, `${randomUUID()}.tgz`); let size = 0;
      const limit = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > 512 * 1024 ** 2) callback(httpError(413, 'Profile upload exceeds 512 MiB. Use the local CLI for larger archives.'));
        else callback(null, chunk);
      } });
      try {
        await pipeline(request.body, limit, createWriteStream(file, { flags: 'wx', mode: 0o600 }));
        const imported = await engine.importProfile(file); reply.code(201); return imported;
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode === 413) throw error;
        throw httpError(400, 'Profile import failed. Use a valid local workbench archive from this operating system.');
      } finally { await rm(file, { force: true }); }
    });
    app.post<{ Body: Record<string, unknown> }>('/api/local-profiles', {
      schema: { body: { type: 'object', additionalProperties: false, properties: {
        name: { type: 'string', maxLength: 200 }, locale: { type: 'string', maxLength: 80 }, timezone: { type: 'string', maxLength: 80 },
        viewport: { type: 'object', additionalProperties: false, required: ['width', 'height'], properties: { width: { type: 'integer', minimum: 320, maximum: 7680 }, height: { type: 'integer', minimum: 200, maximum: 4320 }, deviceScaleFactor: { type: 'number', minimum: 0.5, maximum: 4 } } },
        proxy: { type: 'object', additionalProperties: false, required: ['value', 'extra'], properties: { value: { enum: ['http', 'socks5'] }, extra: { type: 'object', additionalProperties: false, required: ['host', 'port'], properties: { host: { type: 'string', maxLength: 253 }, port: { type: 'integer', minimum: 1, maximum: 65535 }, id: { type: 'string', maxLength: 1024 }, secret: { type: 'string', maxLength: 1024 } } } } },
      } } },
    }, async (request, reply) => {
      try { const profile = await engine.create(request.body); reply.code(201); return profile; }
      catch { throw httpError(400, 'Could not create the profile. Check its locale, timezone and proxy settings.'); }
    });
    app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/local-profiles/:id', {
      schema: { body: { type: 'object', additionalProperties: false, properties: {
        name: { type: 'string', minLength: 1, maxLength: 200 }, locale: { type: 'string', maxLength: 80 }, timezone: { type: 'string', maxLength: 80 },
        viewport: { type: 'object', additionalProperties: false, required: ['width', 'height'], properties: { width: { type: 'integer', minimum: 320, maximum: 7680 }, height: { type: 'integer', minimum: 200, maximum: 4320 }, deviceScaleFactor: { type: 'number', minimum: 0.5, maximum: 4 } } },
        proxy: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, required: ['value', 'extra'], properties: { value: { enum: ['http', 'socks5'] }, extra: { type: 'object', additionalProperties: false, required: ['host', 'port'], properties: { host: { type: 'string', maxLength: 253 }, port: { type: 'integer', minimum: 1, maximum: 65535 }, id: { type: 'string', maxLength: 1024 }, secret: { type: 'string', maxLength: 1024 } } } } }] },
      } } },
    }, async request => {
      unowned(request.params.id);
      try { await engine.update(request.params.id, request.body); return { ok: true }; }
      catch { throw httpError(409, 'Could not update the profile. Stop its browser and check the settings.'); }
    });
    for (const operation of ['start', 'stop', 'duplicate'] as const) {
      app.post<{ Params: { id: string } }>(`/api/local-profiles/:id/${operation}`, async request => {
        unowned(request.params.id);
        if (operation === 'start' && runtime.list().some(run => ['queued', 'starting', 'running', 'awaiting_input', 'paused', 'saving'].includes(run.state))) throw httpError(409, 'Finish queued and active runs before opening a profile manually.');
        return await engine[operation](request.params.id) ?? { ok: true };
      });
    }
    app.get<{ Params: { id: string } }>('/api/local-profiles/:id/archive', async (request, reply) => {
      unowned(request.params.id);
      const name = `manual-${randomUUID()}${engine.archiveExtension}`;
      const file = path.join(config.localExportDir, name);
      await engine.export(request.params.id, file);
      reply.type('application/gzip').header('Content-Disposition', `attachment; filename="${name}"`);
      return reply.send(createReadStream(file));
    });
  }
  app.get('/api/automations', async () => runtime.listAutomations());
  app.get('/api/runs', async () => runtime.list());
  app.post<{ Body: { automationId: string; inputs: Record<string, unknown>; preset?: PacePreset; identityId?: string } }>('/api/runs', {
    schema: { body: { type: 'object', required: ['automationId', 'inputs'], additionalProperties: false, properties: { automationId: { type: 'string', minLength: 1, maxLength: 80 }, inputs: { type: 'object' }, preset: paceSchema, identityId: { type: 'string', pattern: '^[a-f0-9-]{36}$' } } } },
  }, async (request, reply) => {
    if (isLocalEngine(engine)) {
      const activeProfiles = new Set(runtime.list().filter(run => ['starting', 'running', 'awaiting_input', 'paused', 'saving'].includes(run.state)).map(run => run.profileId));
      if ((await engine.listProfiles()).some(profile => profile.state === 'running' && !activeProfiles.has(profile.id))) throw httpError(409, 'Stop manually opened profiles before starting an automation run.');
    }
    const submit = async () => { try { return await runtime.submit(request.body); } catch { throw httpError(400, 'Unknown automation, invalid inputs, or runtime unavailable.'); } };
    const key = request.headers['idempotency-key'];
    try {
      const run = typeof key === 'string' ? await admissions.execute(key, request.body, submit) : await submit(); reply.code(202); return run;
    } catch (error) { if (error instanceof Error && 'status' in error) throw httpError(Number(error.status), error.message); throw error; }
  });
  const getRun = (id: string) => { try { const run = runtime.get(id); if (run) return run; } catch {} throw httpError(404, 'Run not found.'); };
  app.get<{ Params: { id: string } }>('/api/runs/:id', async request => getRun(request.params.id));
  app.get<{ Params: { id: string } }>('/api/runs/:id/evidence', async request => { getRun(request.params.id); return runtime.evidence ? runtime.evidence(request.params.id) : []; });
  for (const operation of ['cancel', 'pause', 'resume', 'retry-export', 'finish'] as const) {
    app.post<{ Params: { id: string } }>(`/api/runs/:id/${operation}`, async request => {
      getRun(request.params.id);
      const method = operation === 'retry-export' ? 'retryExport' : operation === 'finish' ? 'done' : operation;
      try { await runtime[method](request.params.id); } catch { throw httpError(409, 'This operation is not available in the current run state.'); }
      return getRun(request.params.id);
    });
  }
  app.post<{ Params: { id: string }; Body: { challengeId: string; values: Record<string, unknown> } }>('/api/runs/:id/input', {
    schema: { body: { type: 'object', required: ['challengeId', 'values'], additionalProperties: false, properties: { challengeId: { type: 'string', maxLength: 80 }, values: { type: 'object' } } } },
  }, async request => { getRun(request.params.id); await runtime.provideInput(request.params.id, request.body.challengeId, request.body.values); return getRun(request.params.id); });
  app.get<{ Params: { id: string } }>('/api/runs/:id/artifact', async (request, reply) => {
    const run = getRun(request.params.id);
    if (!run.artifact || run.state !== 'saved') throw httpError(409, 'No verified profile export is available.');
    const directory = await realpath(config.localExportDir);
    const file = await realpath(run.artifact.path);
    const relative = path.relative(directory, file);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !['.kameleo', '.workbench.tgz'].some(extension => file.endsWith(extension))) throw httpError(403, 'Artifact path is outside the export directory.');
    reply.type('application/octet-stream').header('Content-Disposition', `attachment; filename="${path.basename(file).replace(/[^a-zA-Z0-9_.-]/g, '_')}"`);
    return reply.send(createReadStream(file));
  });
  app.get<{ Params: { id: string } }>('/api/runs/:id/screenshot', async (request, reply) => {
    const run = getRun(request.params.id);
    if (!activeStates.has(run.state)) throw httpError(409, 'This browser is not active.');
    reply.type('image/jpeg');
    return runtime.screenshot(request.params.id);
  });
  app.get('/api/proxies', async () => proxies.publicInventory());
  app.post<{ Params: { id: string } }>('/api/proxies/:id/check', async request => {
    if (!proxies.check) throw httpError(501, 'This provider does not support an on-demand check.');
    return proxies.check(request.params.id);
  });
  app.get('/api/events', (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    reply.raw.write(': connected\n\n');
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(timer);
      runtime.off('run', onRun);
      streams.delete(reply.raw);
    };
    const close = () => { cleanup(); if (!reply.raw.writableEnded) reply.raw.end(); };
    const write = (data: string) => {
      if (reply.raw.destroyed || reply.raw.writableEnded || !authenticate(request) || reply.raw.writableLength + Buffer.byteLength(data) > 1024 * 1024) { close(); return; }
      reply.raw.write(data);
    };
    const onRun = (run: unknown) => write(`event: run\ndata: ${JSON.stringify(run)}\n\n`);
    runtime.on('run', onRun);
    const timer = setInterval(() => write(': heartbeat\n\n'), 15000);
    timer.unref();
    streams.set(reply.raw, { session: request.cookies.workbench, close });
    reply.raw.on('close', cleanup);
  });
  app.get<{ Params: { id: string } }>('/api/runs/:id/view', async request => {
    const run = getRun(request.params.id);
    if (!config.vncUrl || !canControl(run)) return { available: false, reason: !config.vncUrl ? 'Live control is not configured. Screenshots remain available.' : 'Pause the flow before connecting live controls.' };
    return { available: true, transport: 'vnc', websocketPath: `/api/runs/${run.id}/view/socket`, credentials: config.vncPassword ? { password: config.vncPassword } : undefined };
  });
  app.get<{ Params: { id: string } }>('/api/runs/:id/view/socket', { websocket: true }, (socket, request) => {
    let run;
    try { run = runtime.get(request.params.id); } catch { socket.close(1008, 'Browser is not active'); return; }
    if (!config.vncUrl || !canControl(run)) { socket.close(1008, 'Pause the flow before connecting'); return; }
    viewers.set(socket, { id: run.id, session: request.cookies.workbench, bearer: request.headers.authorization });
    const upstream = new WebSocket(config.vncUrl, { handshakeTimeout: 10000, maxPayload: 16 * 1024 * 1024 });
    const pending: Buffer[] = [];
    let queuedBytes = 0;
    socket.on('message', (data, binary) => {
      if (!canControl(runtime.get(request.params.id))) { socket.close(1008, 'Flow resumed'); return; }
      if (!binary) { socket.close(1003, 'Binary frames required'); return; }
      if (upstream.readyState === WebSocket.OPEN) {
        if (upstream.bufferedAmount > 1024 * 1024) socket.close(1009, 'Display connection is too slow');
        else upstream.send(data);
      }
      else { const buffer = Buffer.from(data as Buffer); queuedBytes += buffer.length; if (queuedBytes > 65536) socket.close(1009, 'Too much buffered data'); else pending.push(buffer); }
    });
    upstream.on('open', () => { for (const data of pending) upstream.send(data); pending.length = 0; });
    upstream.on('message', data => { if (socket.readyState === WebSocket.OPEN) { if (socket.bufferedAmount > 16 * 1024 * 1024) socket.close(1009, 'Viewer is too slow'); else socket.send(data); } });
    upstream.on('error', () => socket.close(1011, 'Display connection failed'));
    upstream.on('close', () => socket.close(1000, 'Display disconnected'));
    socket.on('close', () => { viewers.delete(socket); upstream.close(); });
    socket.on('error', () => upstream.close());
  });
  const closeInactive = (run: any) => {
    if (canControl(run)) return;
    for (const [socket, viewer] of viewers) if (viewer.id === run.id) socket.close(1000, 'Browser is no longer active');
  };
  runtime.on('run', closeInactive);
  const viewerTimer = setInterval(() => {
    for (const [socket, viewer] of viewers) if (!access.valid(viewer.session) && !(viewer.bearer?.startsWith('Bearer ') && access.matches(viewer.bearer.slice(7)))) socket.close(1008, 'Session expired');
  }, 15000);
  viewerTimer.unref();
  // Hijacked SSE replies must end before Fastify waits for in-flight HTTP requests.
  app.addHook('preClose', async () => { for (const stream of streams.values()) stream.close(); });
  app.addHook('onClose', async () => { clearInterval(viewerTimer); runtime.off('run', closeInactive); for (const socket of viewers.keys()) socket.close(); });
  // A harmless fixture: credentials entered here never leave the browser.
  app.get('/demo', async (_request, reply) => reply.type('text/html').send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Workbench test form</title><link rel="stylesheet" href="/demo.css"><main><p>KAMELEO WORKBENCH / TEST PAGE</p><h1>A small form, a complete run.</h1><form><label>Display name<input name="displayName" data-test="message" autocomplete="off" required></label><label>Test passphrase<input name="passphrase" type="password" autocomplete="off"></label><button data-test="save">Submit test form</button></form><p id="result" data-test="saved" role="status"></p></main><script src="/demo.js"></script></html>`));
  app.get('/demo.js', async (_request, reply) => reply.type('application/javascript').send(`document.querySelector('form').addEventListener('submit',event=>{event.preventDefault();document.querySelector('#result').textContent=document.querySelector('[data-test=message]').value;document.body.dataset.complete='true';localStorage.setItem('workbench-demo','completed');document.cookie='workbench_demo=completed; Max-Age=86400; SameSite=Lax; path=/';});`));
  app.get('/demo.css', async (_request, reply) => reply.type('text/css').send('body{font:18px system-ui;background:#edf2f6;color:#203647;margin:10vh auto;max-width:640px}main{padding:40px;background:white;border:1px solid #ced8df}label{display:block;margin:24px 0}input{display:block;padding:12px;margin-top:8px;border:1px solid #8496a4;width:90%}button{background:#255f9c;color:white;border:0;padding:14px 22px;cursor:pointer}p{line-height:1.6}'));
  app.get('/', async (_request, reply) => reply.type('text/html').send(assets.html));
  app.get('/index.html', async (_request, reply) => reply.type('text/html').send(assets.html));
  await app.register(staticFiles, { root: path.join(config.dataDir, 'assets'), prefix: '/assets/', index: false, setHeaders: response => { response.header('Cache-Control', 'public, max-age=31536000, immutable'); } });
  await app.register(staticFiles, { root: path.join(root, 'public'), prefix: '/', index: false, decorateReply: false });
  await app.register(staticFiles, { root: path.join(root, 'node_modules', '@novnc', 'novnc'), prefix: '/vendor/novnc/', decorateReply: false, index: false });
  return app;
}
