// The workbench consumes the standalone browser engine through its public contract.
import { VesperBrowser, VesperBrowserClient } from '@true-utopian/vesper-browser';
export { VesperBrowser as LocalEngine, VesperBrowserClient };
export function isLocalEngine(engine: unknown): engine is VesperBrowser | VesperBrowserClient {
  return engine instanceof VesperBrowser || engine instanceof VesperBrowserClient;
}
export type { LocalEngineOptions, LocalProfileSettings, LocalProfile } from '@true-utopian/vesper-browser';
