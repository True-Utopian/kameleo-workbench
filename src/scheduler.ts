import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Ajv } from 'ajv';
import { AdmissionJournal, acquireProcessLock } from '@true-utopian/vesper-browser';
import { InputVault, durableWrite } from './managed/storage.js';
import type { WorkbenchRuntime } from './server.js';
import { calendarOccurrences } from './calendar.js';

export interface Schedule {
  id: string; name: string; automationId: string; nextAt: number; intervalMs?: number;
  cron?: string; timezone?: string;
  enabled: boolean; state: 'waiting' | 'admitting' | 'running' | 'completed' | 'quarantined';
  createdAt: string; revision: number; occurrence?: number; runId?: string; message?: string;
  history: Array<{ at: number; runId: string; state: string }>;
}
const busy = new Set(['queued', 'preparing', 'starting', 'running', 'paused', 'awaiting_input', 'recovering', 'saving']);
const invalid = (message: string) => Object.assign(new Error(message), { statusCode: 400 });
/** One owner, encrypted inputs, durable occurrence admission, no blind crash replay. */
export class Scheduler {
  private schedules: Schedule[] = [];
  private vault: InputVault;
  private admissions: AdmissionJournal;
  private queue: Promise<unknown> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private closed = false;
  private unlock?: () => Promise<void>;
  constructor(private directory: string, private runtime: WorkbenchRuntime, private now = Date.now) {
    this.vault = new InputVault(join(directory, 'inputs'));
    this.admissions = new AdmissionJournal(join(directory, 'admissions'));
  }
  async init(startTimer = true) {
    this.unlock = await acquireProcessLock(this.directory, () => { this.closed = true; clearInterval(this.timer); });
    try {
    await this.vault.init();
    try { this.schedules = JSON.parse(await readFile(join(this.directory, 'schedules.json'), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    for (const schedule of this.schedules) if (schedule.state === 'admitting') {
      schedule.state = 'quarantined'; schedule.enabled = false;
      schedule.message = 'Admission was interrupted. Inspect run history before creating a replacement schedule.';
    }
    await this.persist();
    if (startTimer) { this.timer = setInterval(() => { void this.tick().catch(() => {}); }, 1000); this.timer.unref(); }
    } catch(error) { await this.unlock?.(); this.unlock=undefined; throw error; }
  }
  list() { return structuredClone(this.schedules); }
  private serial<T>(fn: () => Promise<T>) { const next = this.queue.catch(() => {}).then(fn); this.queue = next.catch(() => {}); return next; }
  private persist() { return durableWrite(join(this.directory, 'schedules.json'), JSON.stringify(this.schedules)); }
  create(value: Record<string, unknown>) { return this.serial(async () => {
    if (this.closed) throw invalid('Scheduler is closed');
    if (Object.keys(value).some(key => !['name','automationId','inputs','nextAt','intervalMs','cron','timezone'].includes(key))) throw invalid('Unknown schedule field');
    if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 120 || typeof value.automationId !== 'string') throw invalid('Enter a name and automation');
    if(value.nextAt!==undefined&&(!Number.isSafeInteger(value.nextAt)||Number(value.nextAt)<0||Number(value.nextAt)>8640000000000000))throw invalid('Invalid schedule time');
    if(value.cron!==undefined&&value.intervalMs!==undefined)throw invalid('Choose either a calendar rule or an interval');
    if(value.cron===undefined&&value.timezone!==undefined)throw invalid('A timezone requires a calendar rule');
    if(value.cron===undefined&&value.nextAt===undefined)throw invalid('Enter the next run time');
    const nextAt=value.cron===undefined?Number(value.nextAt):calendarOccurrences(value.cron,value.timezone??'UTC',Math.max(0,Math.max(this.now(),Number(value.nextAt??this.now()))-(value.nextAt===undefined?0:1)),1)[0]!;
    if (value.intervalMs !== undefined && (!Number.isSafeInteger(value.intervalMs) || Number(value.intervalMs) < 60000 || Number(value.intervalMs) > 31536000000)) throw invalid('Interval must be between one minute and one year');
    const automation = (this.runtime.listAutomations() as Array<{ id: string; inputSchema?: object }>).find(x => x.id === value.automationId);
    if (!automation || !new Ajv({ strict: false }).compile(automation.inputSchema ?? { type: 'object', additionalProperties: false })(value.inputs)) throw invalid('Unknown automation or invalid inputs');
    if (this.schedules.length >= 1000) throw invalid('Schedule limit reached');
    const schedule: Schedule = { id: randomUUID(), name: value.name.trim(), automationId: value.automationId, nextAt, ...(value.intervalMs === undefined ? {} : { intervalMs: Number(value.intervalMs) }), ...(value.cron===undefined?{}:{cron:(value.cron as string).trim(),timezone:String(value.timezone??'UTC')}), enabled: true, state: 'waiting', createdAt: new Date(this.now()).toISOString(), revision: 1, history: [] };
    await this.vault.put(schedule.id, value.inputs);
    this.schedules.push(schedule); await this.persist(); return structuredClone(schedule);
  }); }
  control(id: string, action: 'pause' | 'resume' | 'remove') { return this.serial(async () => {
    const schedule = this.schedules.find(x => x.id === id); if (!schedule) throw Object.assign(new Error('Schedule not found'), { statusCode: 404 });
    if (schedule.state === 'quarantined' && action === 'resume') throw invalid('Quarantined admission cannot be replayed. Inspect runs and create a replacement.');
    if(schedule.state==='completed'&&action==='resume')throw invalid('A completed one-time schedule cannot resume. Create a new schedule.');
    if (action === 'remove') { this.schedules = this.schedules.filter(x => x.id !== id); await this.persist(); await this.vault.delete(id); return { removed: true }; }
    schedule.enabled = action === 'resume'; schedule.revision++; await this.persist(); return structuredClone(schedule);
  }); }
  tick() { return this.serial(async () => {
    if (this.closed) return;
    for (const schedule of this.schedules) if (schedule.state === 'running' && schedule.runId) {
      let run: any; try { run = this.runtime.get(schedule.runId); } catch { continue; }
      if (!busy.has(run.state) && !run.cleanupRequired) {
        schedule.history.push({ at: schedule.occurrence!, runId: run.id, state: run.state }); schedule.history = schedule.history.slice(-100);
        schedule.state = schedule.intervalMs || schedule.cron ? 'waiting' : 'completed';
        // A sleeping/offline PC coalesces missed intervals into one next occurrence.
        if(schedule.cron)schedule.nextAt=calendarOccurrences(schedule.cron,schedule.timezone??'UTC',Math.max(this.now(),schedule.occurrence!),1)[0]!;
        else if (schedule.intervalMs) schedule.nextAt = schedule.occurrence! + (Math.floor(Math.max(0, this.now() - schedule.occurrence!) / schedule.intervalMs) + 1) * schedule.intervalMs;
        else schedule.enabled = false;
        await this.persist();
      }
    }
    if (this.runtime.list().some(run => busy.has(run.state) || run.cleanupRequired)) return;
    const schedule = this.schedules.filter(x => x.enabled && x.state === 'waiting' && x.nextAt <= this.now()).sort((a,b) => a.nextAt - b.nextAt)[0];
    if (!schedule) return;
    schedule.occurrence = schedule.nextAt; schedule.state = 'admitting'; await this.persist();
    try {
      const request = { automationId: schedule.automationId, inputs: await this.vault.get<Record<string, unknown>>(schedule.id) };
      const run = await this.admissions.execute(`schedule-${schedule.id}-${schedule.occurrence}`, request, async () => this.runtime.submit(request)) as { id: string };
      schedule.runId = run.id; schedule.state = 'running'; await this.persist();
    } catch {
      schedule.state = 'quarantined'; schedule.enabled = false; schedule.message = 'Admission failed or is uncertain. Inspect run history before replacing this schedule.'; await this.persist();
    }
  }); }
  async close() { this.closed = true; clearInterval(this.timer); await this.queue; await this.unlock?.(); this.unlock = undefined; }
}
