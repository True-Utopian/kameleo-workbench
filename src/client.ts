import type { RunRecord } from './runtime.js';
import type { AutomationDescriptor } from './automation.js';
import type { PacePreset } from './actions.js';
export interface WorkbenchClientOptions { url: string; token: string; timeoutMs?: number }
export class VesperWorkbenchClient {
  private url: URL;
  constructor(private options: WorkbenchClientOptions) {
    this.url = new URL(options.url);
    if (this.url.protocol !== 'http:' || this.url.hostname !== '127.0.0.1' || !this.url.port || this.url.pathname !== '/' || this.url.username || this.url.password || this.url.search || this.url.hash) throw new Error('Workbench client requires a numeric loopback HTTP origin');
    if (options.token.length < 24) throw new Error('Workbench client requires an access token');
  }
  private route(id: string, action = '') { if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid run ID'); return `/runs/${id}${action ? '/' + action : ''}`; }
  async request<T>(path: string, method = 'GET', body?: unknown, key?: string): Promise<T> {
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('..')) throw new Error('Invalid API path');
    const response = await fetch(new URL('/api/v1' + path, this.url), { method, redirect: 'error', signal: AbortSignal.timeout(this.options.timeoutMs ?? 30000), headers: { authorization: `Bearer ${this.options.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(key ? { 'idempotency-key': key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) { const error = await response.json().catch(() => ({})) as { error?: string }; throw Object.assign(new Error(error.error ?? `Workbench returned ${response.status}`), { status: response.status }); }
    return response.json() as Promise<T>;
  }
  capabilities() { return this.request<{ product: string; apiVersion: string; capabilities: Record<string, unknown> }>('/capabilities'); }
  status() { return this.request<Record<string, unknown>>('/status'); }
  automations() { return this.request<AutomationDescriptor[]>('/automations'); }
  runs() { return this.request<RunRecord[]>('/runs'); }
  run(id: string) { return this.request<RunRecord>(this.route(id)); }
  submit(input: { automationId: string; inputs: Record<string, unknown>; preset?: PacePreset; identityId?: string }, idempotencyKey?: string) { return this.request<RunRecord>('/runs', 'POST', input, idempotencyKey); }
  control(id: string, action: 'pause' | 'resume' | 'cancel' | 'finish' | 'retry-export') { return this.request<RunRecord>(this.route(id, action), 'POST'); }
  input(id: string, challengeId: string, values: Record<string, unknown>) { return this.request<RunRecord>(this.route(id, 'input'), 'POST', { challengeId, values }); }
  evidence(id: string) { return this.request<unknown[]>(this.route(id, 'evidence')); }
  proxies() { return this.request<unknown[]>('/proxies'); }
  checkProxy(id: string) { return this.request<unknown>(`/proxies/${encodeURIComponent(id)}/check`, 'POST'); }
  schedules(){return this.request<import('./scheduler.js').Schedule[]>('/schedules');}
  createSchedule(input:{name:string;automationId:string;inputs:Record<string,unknown>;nextAt?:number;intervalMs?:number;cron?:string;timezone?:string}){return this.request<import('./scheduler.js').Schedule>('/schedules','POST',input);}
  calendarPreview(cron:string,timezone='UTC',after?:number){return this.request<{occurrences:number[]}>('/schedules/preview','POST',{cron,timezone,...(after===undefined?{}:{after})});}
  scheduleControl(id:string,action:'pause'|'resume'|'remove'){if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('Invalid schedule ID');return this.request<unknown>(`/schedules/${id}/${action}`,'POST');}
  flowLibrary(){return this.request<{installed:unknown[];drafts:import('./flow-library.js').FlowDocument[]}>('/flow-library');}
  saveFlow(input:{pack:import('./flows/types.js').FlowPack;manifest:import('./flows/types.js').FlowManifest;revision:number;layout?:Record<string,{x:number;y:number}>}){return this.request<import('./flow-library.js').FlowDocument>('/flow-library','POST',input);}
  publishFlow(id:string,revision:number){if(!/^[a-z][a-z0-9-]{1,63}$/.test(id))throw new Error('Invalid flow ID');return this.request<unknown>(`/flow-library/${id}/publish`,'POST',{revision});}
}
