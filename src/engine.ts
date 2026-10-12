import type { KameleoLocalApiClient } from '@kameleo/local-api-client';

export interface EngineAdapter {
  readonly kind?: string;
  readonly archiveExtension?: string;
  connectionUrl?(profileId: string): Promise<string>;
  close?(): Promise<void>;
  claimProfile?(profileId: string, runId: string): Promise<void>;
  releaseProfile?(profileId: string): Promise<void>;
  ready(): Promise<void>;
  create(settings: Record<string, unknown>): Promise<{ id: string }>;
  install(profileId: string): Promise<void>;
  start(profileId: string): Promise<void>;
  stop(profileId: string): Promise<void>;
  export(profileId: string, path: string): Promise<void>;
  findByRunId?(runId: string): Promise<{ id: string } | undefined>;
  versions?(profileId: string): Promise<{ engineVersion: string; kernelVersion: string }>;
}
export class KameleoEngine implements EngineAdapter {
  readonly kind = 'kameleo';
  readonly archiveExtension = '.kameleo';
  private client?: Promise<KameleoLocalApiClient>;
  constructor(readonly url: string) {}
  private getClient() { return this.client ??= import('@kameleo/local-api-client').then(({ KameleoLocalApiClient }) => new KameleoLocalApiClient({ basePath: this.url })); }
  async ready() { await (await this.getClient()).verifyEngineReady(); }
  async create(settings: Record<string, unknown>) { return (await this.getClient()).profile.createProfile(settings); }
  async install(profileId: string) { await (await this.getClient()).profile.installProfileKernel(profileId); }
  async start(profileId: string) { await (await this.getClient()).profile.startProfile(profileId); }
  async stop(profileId: string) {
    try { await (await this.getClient()).profile.stopProfile(profileId); }
    catch (error) {
      // The intended stopped state already holds. Other failures must block export.
      if (typeof error === 'object' && error !== null) {
        const candidate = error as { status?: number; errorCode?: string; response?: Response };
        if (candidate.status === 409 && candidate.errorCode === 'profile_not_running') return;
        if (candidate.response?.status === 409) {
          const body = await candidate.response.clone().json().catch(() => null) as { errorCode?: string } | null;
          if (body?.errorCode === 'profile_not_running') return;
        }
      }
      throw error;
    }
  }
  async export(profileId: string, path: string) { await (await this.getClient()).profile.exportProfile(profileId, { path }); }
  async findByRunId(runId: string) { return (await (await this.getClient()).profile.listProfiles()).find(profile => profile.name === `run-${runId}`); }
  async versions(profileId: string) {
    const client = await this.getClient();
    const [user, profile] = await Promise.all([client.general.getUserInfo(), client.profile.readProfile(profileId)]);
    return { engineVersion: user.version, kernelVersion: profile.fingerprint.browser.version };
  }
}

export async function browserEndpoint(engine: EngineAdapter, url: string, profileId: string): Promise<string> {
  if (engine.connectionUrl) return engine.connectionUrl(profileId);
  const endpoint = new URL(url);
  endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
  endpoint.pathname = `/puppeteer/${profileId}`; endpoint.search = ''; endpoint.hash = '';
  return endpoint.href;
}
