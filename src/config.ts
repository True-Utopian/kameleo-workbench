import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

export interface Config {
  browserBackend: 'local' | 'kameleo'; localBrowserDir: string; localBrowserExecutable?: string;
  localBrowserHeadless: boolean; localBrowserBuildId?: string;
  vesperBrowserUrl?: string; vesperBrowserTokenFile?: string;
  defaultProxyInventoryIds: string[];
  host: string; port: number; token: string; engineUrl: string; dataDir: string;
  engineExportDir: string; localExportDir: string; automationsDir: string;
  inventoryFile: string; maxConcurrency: number; runTimeoutMs: number;
  publicOrigin?: string; secureCookie: boolean; vncUrl?: string; vncPassword?: string;
  embedOrigins: string[];
  databaseUrl?: string; tenantId?: string; nodeId?: string; teamKey?: string; browserBudget?: number;
  localCoordinator?: boolean;
  flowsDir?: string; flowPoliciesFile?: string; fixtureOrigin?: string; enableTestFixture?: boolean; idleTimeoutMs?: number;
}

function integer(value: string | undefined, fallback: number, min: number, max: number): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new Error(`Expected an integer between ${min} and ${max}`);
  return result;
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<Config> {
  const browserBackend = env.BROWSER_BACKEND ?? 'local';
  if (browserBackend !== 'local' && browserBackend !== 'kameleo') throw new Error('BROWSER_BACKEND must be local or kameleo.');
  let vesperBrowserUrl: string | undefined;
  if (env.VESPER_BROWSER_URL) {
    const endpoint = new URL(env.VESPER_BROWSER_URL);
    if (browserBackend !== 'local' || endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/') {
      throw new Error('VESPER_BROWSER_URL must be a numeric loopback HTTP origin with BROWSER_BACKEND=local.');
    }
    if (!env.VESPER_BROWSER_TOKEN_FILE) throw new Error('VESPER_BROWSER_TOKEN_FILE is required with VESPER_BROWSER_URL.');
    vesperBrowserUrl = endpoint.origin;
  }
  const dataDir = path.resolve(env.WORKBENCH_DATA_DIR ?? (browserBackend === 'local' ? '.workbench/local' : '.workbench'));
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  let token = env.WORKBENCH_TOKEN;
  if (!token) {
    const tokenFile = path.join(dataDir, 'admin-token');
    try { token = (await readFile(tokenFile, 'utf8')).trim(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      token = randomBytes(32).toString('base64url');
      try { await writeFile(tokenFile, token + '\n', { flag: 'wx', mode: 0o600 }); }
      catch (writeError) {
        if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError;
        token = (await readFile(tokenFile, 'utf8')).trim();
      }
    }
  }
  if (token.length < 24) throw new Error('WORKBENCH_TOKEN must contain at least 24 characters.');
  const engineUrl = env.KAMELEO_URL ?? 'http://127.0.0.1:5050';
  if (!['http:', 'https:'].includes(new URL(engineUrl).protocol)) throw new Error('KAMELEO_URL must be HTTP or HTTPS.');
  const localExportDir = path.resolve(env.EXPORT_DIR ?? 'profiles');
  const publicOrigin = env.PUBLIC_ORIGIN ? new URL(env.PUBLIC_ORIGIN).origin : undefined;
  const embedOrigins = (env.EMBED_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean).map(value => new URL(value).origin);
  const maxConcurrency = integer(env.MAX_CONCURRENCY, 1, 1, 100);
  if (env.KAMELEO_VNC_URL && maxConcurrency !== 1) throw new Error('Live VNC requires MAX_CONCURRENCY=1: one display must not expose multiple runs.');
  if (browserBackend === 'local' && env.KAMELEO_VNC_URL) throw new Error('Local browsers use the native window and snapshots. Unset KAMELEO_VNC_URL.');
  return {
    browserBackend, localBrowserDir: path.resolve(env.LOCAL_BROWSER_DIR ?? path.join(env.WORKBENCH_DATA_DIR ?? '.workbench', 'local-engine')),
    localBrowserExecutable: env.LOCAL_BROWSER_EXECUTABLE, localBrowserHeadless: env.LOCAL_BROWSER_HEADLESS === 'true',
    localBrowserBuildId: env.LOCAL_BROWSER_BUILD_ID,
    vesperBrowserUrl, vesperBrowserTokenFile: env.VESPER_BROWSER_TOKEN_FILE ? path.resolve(env.VESPER_BROWSER_TOKEN_FILE) : undefined,
    defaultProxyInventoryIds: (env.DEFAULT_PROXY_INVENTORY_IDS ?? '').split(',').map(id => id.trim()).filter(Boolean),
    host: env.HOST ?? '127.0.0.1', port: integer(env.PORT, 3180, env.VESPER_DESKTOP === 'true' ? 0 : 1, 65535), token,
    engineUrl, dataDir, localExportDir,
    engineExportDir: env.KAMELEO_EXPORT_DIR ?? localExportDir,
    automationsDir: path.resolve(env.AUTOMATIONS_DIR ?? 'automations'),
    inventoryFile: path.resolve(env.PROXY_INVENTORY_FILE ?? 'proxy-inventory.json'),
    maxConcurrency, runTimeoutMs: integer(env.RUN_TIMEOUT_MS, 600_000, 1_000, 86_400_000),
    publicOrigin, secureCookie: env.COOKIE_SECURE === 'true' || publicOrigin?.startsWith('https://') === true,
    vncUrl: env.KAMELEO_VNC_URL, vncPassword: env.VNC_PASSWORD, embedOrigins,
    databaseUrl: env.DATABASE_URL, tenantId: env.WORKBENCH_TENANT_ID, nodeId: env.WORKBENCH_NODE_ID,
    localCoordinator: env.VESPER_LOCAL_COORDINATOR === 'true',
    teamKey: env.KAMELEO_TEAM_KEY, browserBudget: integer(env.KAMELEO_BROWSER_BUDGET, 1, 1, 1000),
    flowsDir: path.resolve(env.FLOWS_DIR ?? 'flows'), flowPoliciesFile: env.FLOW_POLICIES_FILE,
    fixtureOrigin: env.FIXTURE_ORIGIN ? new URL(env.FIXTURE_ORIGIN).origin : undefined,
    enableTestFixture: env.ENABLE_TEST_FIXTURE === 'true', idleTimeoutMs: integer(env.IDLE_TIMEOUT_MS, 180_000, 10_000, 86_400_000),
  };
}
