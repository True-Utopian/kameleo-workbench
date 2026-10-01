import { readFile } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { ProxyError, type ProxyAttributes, type ProxyCandidate, type ProxyConnection, type ProxyConnectionInput, type ProxyInventoryEntry, type ProxyProvider, type ProxyProviderContext, type ProxyRequest } from './types.js';

const attributeKeys = ['type', 'country', 'region', 'state', 'city', 'isp', 'asn'] as const;
const proxyTypes = new Set(['residential', 'isp', 'datacenter', 'mobile']);
export function sanitizeAttributes(input: ProxyAttributes | undefined): ProxyAttributes {
  const result: Record<string, string | number> = {};
  if (!input || typeof input !== 'object') return {};
  for (const key of attributeKeys) {
    const value = input[key];
    if (value === undefined) continue;
    if ((typeof value !== 'string' && !(key === 'asn' && typeof value === 'number')) || String(value).length > 128 || !String(value).trim()) {
      throw new ProxyError('INVALID_ATTRIBUTES', 'Proxy attributes must be short nonempty strings (or a numeric ASN).');
    }
    if (key === 'type' && !proxyTypes.has(String(value))) throw new ProxyError('INVALID_TYPE', 'Unsupported proxy type.');
    if (key === 'country' && !/^[a-z]{2}$/i.test(String(value))) throw new ProxyError('INVALID_COUNTRY', 'Country must be a two-letter code.');
    result[key] = key === 'country' ? String(value).toUpperCase() : value;
  }
  return result as ProxyAttributes;
}

function resolveEnv(name: unknown, environment: NodeJS.ProcessEnv): string | undefined {
  if (name === undefined) return undefined;
  if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new ProxyError('INVALID_SECRET_REFERENCE', 'Invalid proxy credential environment reference.');
  const value = environment[name];
  if (!value) throw new ProxyError('MISSING_PROXY_CREDENTIAL', `Required proxy credential environment variable ${name} is missing.`);
  return value;
}

export function resolveConnection(input: ProxyConnectionInput, environment: NodeJS.ProcessEnv): ProxyConnection {
  if (!input || !['http', 'https', 'socks5'].includes(input.protocol)) throw new ProxyError('INVALID_PROTOCOL', 'Proxy protocol must be http, https, or socks5.');
  if (typeof input.host !== 'string') throw new ProxyError('INVALID_HOST', 'Invalid proxy host.');
  const host = input.host.replace(/^\[|\]$/g, '');
  if (!isIP(host) && (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host) || host.length > 253 || host.includes('..'))) throw new ProxyError('INVALID_HOST', 'Proxy host must be a hostname or IP without a scheme or credentials.');
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw new ProxyError('INVALID_PORT', 'Invalid proxy port.');
  if ((input.username !== undefined && typeof input.username !== 'string') || (input.password !== undefined && typeof input.password !== 'string')) throw new ProxyError('INVALID_CREDENTIALS', 'Proxy credentials must be strings.');
  if ((input.username !== undefined && input.usernameEnv !== undefined) || (input.password !== undefined && input.passwordEnv !== undefined)) throw new ProxyError('AMBIGUOUS_CREDENTIALS', 'Use either a literal credential or an environment reference.');
  const username = resolveEnv(input.usernameEnv, environment) ?? input.username;
  const password = resolveEnv(input.passwordEnv, environment) ?? input.password;
  if (password !== undefined && username === undefined) throw new ProxyError('INVALID_CREDENTIALS', 'A proxy password requires a username.');
  return { protocol: input.protocol, host, port: input.port, username, password };
}

export function connectionKey(connection: ProxyConnection): string {
  return createHash('sha256').update(JSON.stringify({ ...connection, protocol: connection.protocol === 'https' ? 'http' : connection.protocol })).digest('hex');
}

export class DirectProxyProvider implements ProxyProvider {
  readonly name = 'direct';
  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}
  async *candidates(request: ProxyRequest): AsyncIterable<ProxyCandidate> {
    if (!request.proxy) throw new ProxyError('MISSING_PROXY', 'The direct provider requires a proxy connection.');
    const connection = resolveConnection(request.proxy, this.environment);
    yield { id: `direct-${randomUUID()}`, provider: this.name, connection, declared: sanitizeAttributes(request) };
  }
}

export class InventoryProxyProvider implements ProxyProvider {
  readonly name = 'inventory';
  constructor(readonly file: string, private readonly environment: NodeJS.ProcessEnv = process.env) {}
  async entries(): Promise<ProxyInventoryEntry[]> {
    let contents: string;
    try { contents = await readFile(this.file, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw new ProxyError('INVENTORY_READ_FAILED', 'Could not read the proxy inventory.'); }
    let parsed: unknown;
    try { parsed = JSON.parse(contents); } catch { throw new ProxyError('INVALID_INVENTORY', 'Proxy inventory is not valid JSON.'); }
    const entries = Array.isArray(parsed) ? parsed : (parsed as { proxies?: unknown })?.proxies;
    if (!Array.isArray(entries) || entries.length > 100_000) throw new ProxyError('INVALID_INVENTORY', 'Proxy inventory requires a proxies array.');
    const seen = new Set<string>();
    return entries.map((entry: unknown) => {
      if (!entry || typeof entry !== 'object') throw new ProxyError('INVALID_INVENTORY', 'Invalid proxy inventory entry.');
      const item = entry as ProxyInventoryEntry;
      if (typeof item.id !== 'string' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(item.id) || seen.has(item.id)) throw new ProxyError('INVALID_INVENTORY_ID', 'Proxy inventory IDs must be unique simple identifiers.');
      seen.add(item.id);
      if (item.source !== undefined && (typeof item.source !== 'string' || !/^[a-zA-Z0-9_.-]{1,64}$/.test(item.source))) throw new ProxyError('INVALID_INVENTORY', 'Invalid inventory source label.');
      if (item.enabled !== undefined && typeof item.enabled !== 'boolean') throw new ProxyError('INVALID_INVENTORY', 'Inventory enabled must be boolean.');
      for (const date of [item.createdAt, item.expiresAt]) if (date !== undefined && (typeof date !== 'string' || !Number.isFinite(Date.parse(date)))) throw new ProxyError('INVALID_INVENTORY', 'Invalid inventory timestamp.');
      // Structural validation must not require secrets just to list inventory.
      resolveConnection({ protocol: item.protocol, host: item.host, port: item.port }, this.environment);
      return { ...item, attributes: sanitizeAttributes(item.attributes) };
    });
  }
  async *candidates(request: ProxyRequest): AsyncIterable<ProxyCandidate> {
    for (const entry of await this.entries()) {
      if (entry.enabled === false || (request.inventoryIds && !request.inventoryIds.includes(entry.id))) continue;
      yield {
        id: entry.id, provider: this.name, source: entry.source,
        connection: resolveConnection(entry, this.environment), declared: sanitizeAttributes(entry.attributes),
        createdAt: entry.createdAt, expiresAt: entry.expiresAt,
      };
    }
  }
}

export interface IPRoyalOptions {
  usernameEnv?: string;
  passwordEnv?: string;
  hostname?: string;
  lifetime?: string;
  /** Stop on peer loss rather than silently rotating. Default true. */
  killswitch?: boolean;
}

export function iproyalLifetimeMs(lifetime: string): number {
  const match = /^(\d+)(s|m|h|d)$/.exec(lifetime);
  if (!match) throw new ProxyError('INVALID_LIFETIME', 'IPRoyal lifetime requires one time unit, e.g. 30m or 1h.');
  const count = Number(match[1]);
  const unit = match[2]!;
  const maximum: Record<string, number> = { s: 59, m: 59, h: 24, d: 7 };
  const multiplier: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  if (count < 1 || count > maximum[unit]!) throw new ProxyError('INVALID_LIFETIME', 'IPRoyal lifetime exceeds its documented unit limit.');
  return count * multiplier[unit]!;
}

/** Local construction is the provider's documented allocation mechanism; no purchase API is called. */
export class IPRoyalProxyProvider implements ProxyProvider {
  readonly name = 'iproyal';
  constructor(private readonly options: IPRoyalOptions = {}, private readonly environment: NodeJS.ProcessEnv = process.env) {}
  async *candidates(request: ProxyRequest, context: ProxyProviderContext): AsyncIterable<ProxyCandidate> {
    if (request.type && request.type !== 'residential') throw new ProxyError('UNSUPPORTED_TYPE', 'This IPRoyal provider supports rotating residential inventory only. Import purchased ISP/mobile/datacenter proxies into inventory.');
    if (request.asn !== undefined) throw new ProxyError('UNSUPPORTED_FILTER', 'IPRoyal residential ASN targeting is not documented; use an inventory or an independent verifier.');
    if (request.city && !request.country) throw new ProxyError('INVALID_TARGET', 'IPRoyal city targeting also requires a country.');
    if (request.state && request.country?.toUpperCase() !== 'US') throw new ProxyError('INVALID_TARGET', 'IPRoyal state targeting requires country US.');
    const username = resolveEnv(this.options.usernameEnv ?? 'IPROYAL_PROXY_USERNAME', this.environment)!;
    const password = resolveEnv(this.options.passwordEnv ?? 'IPROYAL_PROXY_PASSWORD', this.environment)!;
    const lifetime = request.iproyal?.lifetime ?? this.options.lifetime ?? '1h';
    const lifetimeMs = iproyalLifetimeMs(lifetime);
    let location = '';
    for (const key of ['region', 'country', 'state', 'city', 'isp'] as const) {
      const value = request[key];
      if (!value) continue;
      if (!/^[a-z0-9-]{1,80}$/i.test(value)) throw new ProxyError('INVALID_TARGET', 'IPRoyal target values must use provider location codes without spaces or directives.');
      location += `_${key}-${value.toLowerCase()}`;
    }
    const protocol = request.protocol ?? 'http';
    for (let attempt = 0; attempt < context.maxAttempts; attempt++) {
      context.signal.throwIfAborted();
      const session = randomBytes(4).toString('hex');
      const connection = resolveConnection({
        protocol, host: this.options.hostname ?? 'geo.iproyal.com', port: protocol === 'socks5' ? 32325 : 12321,
        username, password: `${password}${location}_session-${session}_lifetime-${lifetime}${this.options.killswitch === false ? '' : '_killswitch-1'}`,
      }, this.environment);
      const now = Date.now();
      yield { id: `iproyal-${session}`, provider: this.name, connection, declared: sanitizeAttributes({ ...request, type: 'residential' }), createdAt: new Date(now).toISOString(), expiresAt: new Date(now + lifetimeMs).toISOString() };
    }
  }
}
