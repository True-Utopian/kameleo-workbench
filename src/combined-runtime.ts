import { EventEmitter } from 'node:events';
import { Runtime } from './runtime.js';
import { ManagedRuntime } from './managed/runtime.js';
import type { WorkbenchRuntime } from './server.js';

/** Scripts and durable flows share one desktop UI and Browser API, with separate journals. */
export class CombinedRuntime extends EventEmitter implements WorkbenchRuntime {
  private removers: Array<() => void> = [];
  private admissions: Promise<unknown> = Promise.resolve();
  constructor(private scripts: Runtime, private flows: ManagedRuntime) {
    super();
    for (const runtime of [scripts, flows]) {
      const listener = (record: unknown) => this.emit('run', record);
      runtime.on('run', listener); this.removers.push(() => runtime.off('run', listener));
    }
  }
  async init() { await this.scripts.init(); try { await this.flows.init(); } catch (error) { await this.scripts.close(); await this.flows.close(); throw error; } }
  listAutomations() { return [...this.scripts.listAutomations(), ...this.flows.listAutomations()]; }
  flowDefinitions() { return this.flows.flowDefinitions(); }
  installFlow(...args: Parameters<ManagedRuntime['installFlow']>) {
    if (this.scripts.listAutomations().some(automation => automation.id === args[0].id)) throw new Error('A script already uses that automation ID');
    return this.flows.installFlow(...args);
  }
  list() { return [...this.scripts.list(), ...this.flows.list()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  private runtime(id: string) { try { this.scripts.get(id); return this.scripts; } catch { return this.flows; } }
  get(id: string) { return this.runtime(id).get(id); }
  submit(input: Parameters<Runtime['submit']>[0] & { identityId?: string }) {
    const admitted = this.admissions.catch(() => {}).then(() => this.admit(input));
    this.admissions = admitted; return admitted;
  }
  private admit(input: Parameters<Runtime['submit']>[0] & { identityId?: string }) {
    const target = this.flows.listAutomations().some(automation => automation.id === input.automationId) ? this.flows : this.scripts;
    // Independent queues must not launch competing headed sessions. Queue coordination can
    // be expanded later; admission is explicit until both execution modes share one scheduler.
    if (this.list().some(run => ['queued', 'starting', 'running', 'awaiting_input', 'paused', 'saving'].includes(run.state))) throw new Error('Finish the active run before submitting another local job');
    return target.submit(input);
  }
  cancel(id: string) { return this.runtime(id).cancel(id); }
  pause(id: string) { return this.runtime(id).pause(id); }
  resume(id: string) { return this.runtime(id).resume(id); }
  retryExport(id: string) { return this.runtime(id).retryExport(id); }
  done(id: string) { return this.runtime(id).done(id); }
  provideInput(id: string, challengeId: string, values: Record<string, unknown>) { return this.runtime(id).provideInput(id, challengeId, values); }
  screenshot(id: string) { return this.runtime(id).screenshot(id); }
  evidence(id: string) { return this.runtime(id) === this.flows ? this.flows.evidence(id) : Promise.resolve([]); }
  stats() { return this.flows.stats(); }
  async close() { await this.scripts.close(); await this.flows.close(); for (const remove of this.removers) remove(); }
}
