import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

export interface Config {
  host: string; port: number; token: string; engineUrl: string; dataDir: string;
  engineExportDir: string; localExportDir: string; automationsDir: string;
  inventoryFile: string; maxConcurrency: number; runTimeoutMs: number;
  publicOrigin?: string; secureCookie: boolean; vncUrl?: string; vncPassword?: string;
  embedOrigins: string[];
}

function integer(value: string | undefined, fallback: number, min: number, max: number): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new Error(`Expected an integer between ${min} and ${max}`);
  return result;
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<Config> {
  const dataDir = path.resolve(env.WORKBENCH_DATA_DIR ?? '.workbench');
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
  return {
    host: env.HOST ?? '127.0.0.1', port: integer(env.PORT, 3180, 1, 65535), token,
    engineUrl, dataDir, localExportDir,
    engineExportDir: env.KAMELEO_EXPORT_DIR ?? localExportDir,
    automationsDir: path.resolve(env.AUTOMATIONS_DIR ?? 'automations'),
    inventoryFile: path.resolve(env.PROXY_INVENTORY_FILE ?? 'proxy-inventory.json'),
    maxConcurrency, runTimeoutMs: integer(env.RUN_TIMEOUT_MS, 600_000, 1_000, 86_400_000),
    publicOrigin, secureCookie: env.COOKIE_SECURE === 'true' || publicOrigin?.startsWith('https://') === true,
    vncUrl: env.KAMELEO_VNC_URL, vncPassword: env.VNC_PASSWORD, embedOrigins,
  };
}
