import type { Browser, Page } from 'puppeteer-core';
import type { Actions, PacePreset } from './actions.js';

export type JsonSchema = Record<string, unknown>;
export interface InputChallenge { id: string; title: string; fields: JsonSchema }
export interface AutomationContext {
  inputs: Record<string, unknown>;
  browser: Browser;
  page: Page;
  actions: Actions;
  signal: AbortSignal;
  log(message: string): void;
  checkpoint(): Promise<void>;
  requestInput(title: string, fields: JsonSchema): Promise<Record<string, unknown>>;
  /** Disconnect, stop and export. This promise does not return normally. */
  done(): Promise<never>;
  /** Leave the browser open until the operator clicks Done. */
  waitForFinish(): Promise<never>;
}
export interface Automation {
  id: string;
  title: string;
  description?: string;
  inputSchema?: JsonSchema;
  preset?: PacePreset;
  /** Return Kameleo CreateProfileRequest fields on the trusted coordinator. */
  profile?: (context: { inputs: Record<string, unknown>; runId: string; signal: AbortSignal }) => Promise<Record<string, unknown>> | Record<string, unknown>;
  /** Return a ProxyManager allocation request for existing proxy service. */
  proxy?: (context: { inputs: Record<string, unknown>; runId: string; signal: AbortSignal }) => Promise<Record<string, unknown>> | Record<string, unknown>;
  run(context: AutomationContext): Promise<void>;
}
export interface AutomationDescriptor { id: string; title: string; description: string; inputSchema: JsonSchema }
export function defineAutomation<T extends Automation>(automation: T): T { return automation; }
