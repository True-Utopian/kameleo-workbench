import { KameleoLocalApiClient } from '@kameleo/local-api-client';

export interface EngineAdapter {
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
  private client: KameleoLocalApiClient;
  constructor(readonly url: string) { this.client = new KameleoLocalApiClient({ basePath: url }); }
  async ready() { await this.client.verifyEngineReady(); }
  async create(settings: Record<string, unknown>) { return this.client.profile.createProfile(settings); }
  async install(profileId: string) { await this.client.profile.installProfileKernel(profileId); }
  async start(profileId: string) { await this.client.profile.startProfile(profileId); }
  async stop(profileId: string) {
    try { await this.client.profile.stopProfile(profileId); }
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
  async export(profileId: string, path: string) { await this.client.profile.exportProfile(profileId, { path }); }
  async findByRunId(runId: string) { return (await this.client.profile.listProfiles()).find(profile => profile.name === `run-${runId}`); }
  async versions(profileId: string) {
    const [user, profile] = await Promise.all([this.client.general.getUserInfo(), this.client.profile.readProfile(profileId)]);
    return { engineVersion: user.version, kernelVersion: profile.fingerprint.browser.version };
  }
}
