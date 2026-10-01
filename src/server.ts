import Fastify, { type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import websocket from '@fastify/websocket';
import { WebSocket } from 'ws';
import { createReadStream } from 'node:fs';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerResponse } from 'node:http';
import { AccessControl } from './auth.js';
import type { Config } from './config.js';
import type { PacePreset } from './actions.js';

// The interface makes API tests independent of a running, licensed engine.
export interface WorkbenchRuntime {
  listAutomations(): unknown;
  submit(input: { automationId: string; inputs: Record<string, unknown>; preset?: PacePreset }): unknown;
  list(): any[];
  get(id: string): any;
  cancel(id: string): unknown; pause(id: string): unknown; resume(id: string): unknown;
  retryExport(id: string): unknown; done(id: string): unknown;
  provideInput(id: string, challengeId: string, values: Record<string, unknown>): unknown;
  screenshot(id: string): Promise<Buffer>;
  on(event: string, fn: (...args: any[]) => void): unknown;
  off(event: string, fn: (...args: any[]) => void): unknown;
}
export interface WorkbenchProxies { publicInventory(): unknown; check?(id: string): Promise<unknown> }
const activeStates = new Set(['running', 'paused', 'awaiting_input']);
const paceSchema = { anyOf: [
  { enum: ['fast', 'natural', 'natural-fast'] },
  { type: 'object', additionalProperties: false, properties: Object.fromEntries(['typingDelayMs', 'typingJitterMs', 'actionDelayMs', 'actionJitterMs', 'pointerDurationMs', 'clickDelayMs'].map(key => [key, { type: 'number', minimum: 0, maximum: 10000 }]).concat([['pointerSteps', { type: 'integer', minimum: 1, maximum: 100 }]])) },
] };
function httpError(statusCode: number, message: string) { return Object.assign(new Error(message), { statusCode }); }

export async function createServer(config: Config, runtime: WorkbenchRuntime, proxies: WorkbenchProxies) {
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024, trustProxy: false });
  const access = new AccessControl(config.token);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const viewers = new Map<WebSocket, { id: string; session?: string; bearer?: string }>();
  const streams = new Map<ServerResponse, { session?: string; close: () => void }>();
  await app.register(cookie);
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
    if (request.url.split('?')[0] === '/api/login') return;
    if (!authenticate(request)) throw httpError(401, 'Sign in to the workbench.');
  });
  app.setErrorHandler((error, _request, reply) => {
    const status = Number((error as any).statusCode ?? 500);
    // Upstream exceptions can include request bodies, proxy credentials or URLs.
    reply.code(status >= 400 && status <= 599 ? status : 500).send({ error: status < 500 && error instanceof Error ? error.message : 'The operation failed. Check the run state or engine availability.' });
  });
  app.get('/healthz', async () => ({ ok: true }));
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
    try { ready = (await fetch(`${config.engineUrl}/general/healthcheck`, { signal: AbortSignal.timeout(2500) })).ok; } catch {}
    const runs = runtime.list();
    return { engine: { ready, ...(!ready ? { error: 'Engine is not ready.' } : {}) }, config: { maxConcurrency: config.maxConcurrency }, stats: { total: runs.length, active: runs.filter(run => activeStates.has(run.state)).length, saved: runs.filter(run => run.state === 'saved').length, cleanupRequired: runs.filter(run => run.cleanupRequired && ['failed', 'cancelled', 'interrupted', 'export_failed'].includes(run.state)).length } };
  });
  app.get('/api/automations', async () => runtime.listAutomations());
  app.get('/api/runs', async () => runtime.list());
  app.post<{ Body: { automationId: string; inputs: Record<string, unknown>; preset?: PacePreset } }>('/api/runs', {
    schema: { body: { type: 'object', required: ['automationId', 'inputs'], additionalProperties: false, properties: { automationId: { type: 'string', minLength: 1, maxLength: 80 }, inputs: { type: 'object' }, preset: paceSchema } } },
  }, async (request, reply) => { try { const run = await runtime.submit(request.body); reply.code(202); return run; } catch { throw httpError(400, 'Unknown automation, invalid inputs, or runtime unavailable.'); } });
  const getRun = (id: string) => { try { const run = runtime.get(id); if (run) return run; } catch {} throw httpError(404, 'Run not found.'); };
  app.get<{ Params: { id: string } }>('/api/runs/:id', async request => getRun(request.params.id));
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
    if (relative.startsWith('..') || path.isAbsolute(relative) || !file.endsWith('.kameleo')) throw httpError(403, 'Artifact path is outside the export directory.');
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
    if (!config.vncUrl || !activeStates.has(run.state)) return { available: false, reason: !config.vncUrl ? 'Live view is not configured. Use screenshots or the native Kameleo window.' : 'Start this browser to connect to its display.' };
    return { available: true, transport: 'vnc', websocketPath: `/api/runs/${run.id}/view/socket`, credentials: config.vncPassword ? { password: config.vncPassword } : undefined };
  });
  app.get<{ Params: { id: string } }>('/api/runs/:id/view/socket', { websocket: true }, (socket, request) => {
    let run;
    try { run = runtime.get(request.params.id); } catch { socket.close(1008, 'Browser is not active'); return; }
    if (!config.vncUrl || !run || !activeStates.has(run.state)) { socket.close(1008, 'Browser is not active'); return; }
    viewers.set(socket, { id: run.id, session: request.cookies.workbench, bearer: request.headers.authorization });
    const upstream = new WebSocket(config.vncUrl, { handshakeTimeout: 10000, maxPayload: 16 * 1024 * 1024 });
    const pending: Buffer[] = [];
    let queuedBytes = 0;
    socket.on('message', (data, binary) => {
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
    if (activeStates.has(run.state)) return;
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
  await app.register(staticFiles, { root: path.join(root, 'public'), prefix: '/', index: 'index.html' });
  await app.register(staticFiles, { root: path.join(root, 'node_modules', '@novnc', 'novnc'), prefix: '/vendor/novnc/', decorateReply: false, index: false });
  return app;
}
