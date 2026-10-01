import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { createHttpsProbe, type HttpsProbeOptions } from './probe.js';
import { connectionKey, DirectProxyProvider, InventoryProxyProvider, IPRoyalProxyProvider, sanitizeAttributes, type IPRoyalOptions } from './providers.js';
import { ProxyError, type ProxyAttributes, type ProxyCandidate, type ProxyLease, type ProxyProbe, type ProxyProbeResult, type ProxyProvider, type ProxyReport, type ProxyRequest, type PublicProxyInventoryEntry } from './types.js';

export * from './types.js';
export { createHttpsProbe, type HttpsProbeOptions } from './probe.js';
export { DirectProxyProvider, InventoryProxyProvider, IPRoyalProxyProvider, iproyalLifetimeMs, type IPRoyalOptions } from './providers.js';

export interface ProxyManagerOptions {
  inventoryFile?: string;
  iproyal?: IPRoyalOptions;
  probe?: ProxyProbe;
  probeOptions?: HttpsProbeOptions;
  providers?: ProxyProvider[];
  env?: NodeJS.ProcessEnv;
}
export class ProxyAllocationError extends ProxyError {
  constructor(public readonly reasons: string[]) {
    super('PROXY_ALLOCATION_FAILED', `No eligible healthy proxy could be allocated (${[...new Set(reasons)].join(', ') || 'NO_CANDIDATES'}).`);
    this.name = 'ProxyAllocationError';
  }
}

function boundedNumber(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new ProxyError('INVALID_LIMIT', 'Invalid proxy allocation limit.');
  return value;
}

function normalized(key: keyof ProxyAttributes, value: string | number | undefined): string {
  const text = String(value ?? '').trim().toLowerCase();
  return key === 'asn' ? text.replace(/^as/, '') : text;
}
function matches(request: ProxyAttributes, attributes: ProxyAttributes): boolean {
  for (const key of ['type', 'country', 'region', 'state', 'city', 'isp', 'asn'] as const) {
    if (request[key] !== undefined && normalized(key, request[key]) !== normalized(key, attributes[key])) return false;
  }
  return true;
}
function canonicalIp(ip: string): string {
  if (isIP(ip) === 6) {
    const canonical = new URL(`http://[${ip}]`).hostname.toLowerCase();
    const mapped = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/.exec(canonical);
    if (mapped) {
      const high = parseInt(mapped[1]!, 16), low = parseInt(mapped[2]!, 16);
      return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
    }
    return canonical;
  }
  return ip;
}
function safeCode(error: unknown): string {
  return error instanceof ProxyError && /^[A-Z0-9_]{1,60}$/.test(error.code) ? error.code : 'PROVIDER_OR_PROBE_FAILED';
}
async function withSignal<T>(promise: Promise<T>, signal: AbortSignal, abortCode = 'ALLOCATION_ABORTED'): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const abort = () => reject(new ProxyError(abortCode, 'Proxy allocation or verification was cancelled or timed out.'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolvePromise, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

/** Single-process lease owner. Share one instance across all runs in a workbench. */
export class ProxyManager {
  private readonly providers = new Map<string, ProxyProvider>();
  private readonly inventory: InventoryProxyProvider;
  private readonly probeConnection: ProxyProbe;
  private readonly reservations = new Map<string, string>();
  private readonly exitReservations = new Map<string, string>();
  private readonly active = new Map<string, { lease: ProxyLease; connectionKey: string; inventoryId?: string; exitKey: string }>();
  private readonly lastUsed = new Map<string, number>();
  private readonly lastExitUsed = new Map<string, number>();

  constructor(options: ProxyManagerOptions = {}) {
    const environment = options.env ?? process.env;
    this.inventory = new InventoryProxyProvider(resolve(options.inventoryFile ?? 'proxy-inventory.json'), environment);
    this.probeConnection = options.probe ?? createHttpsProbe(options.probeOptions);
    this.register(new DirectProxyProvider(environment));
    this.register(this.inventory);
    this.register(new IPRoyalProxyProvider(options.iproyal, environment));
    for (const provider of options.providers ?? []) this.register(provider);
  }

  register(provider: ProxyProvider): void {
    if (!provider.name || this.providers.has(provider.name)) throw new ProxyError('DUPLICATE_PROVIDER', 'Proxy provider names must be unique.');
    this.providers.set(provider.name, provider);
  }

  async allocate(request: ProxyRequest, runId: string, signal?: AbortSignal): Promise<ProxyLease> {
    if (!request || typeof request.provider !== 'string' || typeof runId !== 'string' || !runId) throw new ProxyError('INVALID_REQUEST', 'A proxy provider and run ID are required.');
    const provider = this.providers.get(request.provider);
    if (!provider) throw new ProxyError('UNKNOWN_PROVIDER', 'The requested proxy provider is not registered.');
    const requestedAttributes = sanitizeAttributes(request);
    const attempts = boundedNumber(request.maxAttempts, 8, 1, 100);
    if (!Number.isInteger(attempts)) throw new ProxyError('INVALID_LIMIT', 'maxAttempts must be an integer.');
    const timeoutMs = boundedNumber(request.timeoutMs, 30_000, 1, 300_000);
    const probeTimeoutMs = boundedNumber(request.probeTimeoutMs, 8_000, 1, 120_000);
    const maxLatencyMs = boundedNumber(request.maxLatencyMs, 30_000, 0, 300_000);
    const minRemainingMs = boundedNumber(request.minRemainingMs, 0, 0, 2_592_000_000);
    const maxVerificationAgeMs = boundedNumber(request.freshness?.maxVerificationAgeMs, 30_000, 0, 300_000);
    const maxInventoryAgeMs = boundedNumber(request.freshness?.maxInventoryAgeMs, Number.MAX_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER);
    const unusedForMs = boundedNumber(request.freshness?.unusedForMs, 0, 0, Number.MAX_SAFE_INTEGER);
    if (request.protocol && !['http', 'https', 'socks5'].includes(request.protocol)) throw new ProxyError('INVALID_PROTOCOL', 'Unsupported proxy protocol.');
    if (request.inventoryIds && (!Array.isArray(request.inventoryIds) || request.inventoryIds.some((id) => typeof id !== 'string'))) throw new ProxyError('INVALID_REQUEST', 'inventoryIds must be strings.');
    const allowedAttributes = new Set(['type', 'country', 'region', 'state', 'city', 'isp', 'asn']);
    if (request.requireVerified && (!Array.isArray(request.requireVerified) || request.requireVerified.some((key) => !allowedAttributes.has(key)))) throw new ProxyError('INVALID_REQUEST', 'Invalid independent-verification attributes.');
    const combined = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]);
    const iterator = provider.candidates(request, { signal: combined, maxAttempts: attempts })[Symbol.asyncIterator]();
    const reasons: string[] = [];
    let tried = 0;
    // Scanning is bounded separately from network attempts so ineligible entries do not starve matching ones.
    let scanned = 0;
    try {
      while (tried < attempts && scanned++ < 100_000) {
        const next = await withSignal(iterator.next(), combined);
        if (next.done) break;
        const candidate: ProxyCandidate = next.value;
        if (!candidate || candidate.provider !== request.provider || !candidate.connection || typeof candidate.id !== 'string') throw new ProxyError('INVALID_CANDIDATE', 'Provider returned an invalid candidate.');
        const declared = sanitizeAttributes(candidate.declared);
        if (!matches(requestedAttributes, declared)) { reasons.push('ATTRIBUTE_MISMATCH'); continue; }
        if (request.protocol && (request.protocol === 'socks5') !== (candidate.connection.protocol === 'socks5')) { reasons.push('PROTOCOL_MISMATCH'); continue; }
        const now = Date.now();
        const expiry = candidate.expiresAt ? Date.parse(candidate.expiresAt) : undefined;
        if (expiry === undefined && minRemainingMs > 0) { reasons.push('EXPIRY_UNKNOWN'); continue; }
        if (expiry !== undefined && (!Number.isFinite(expiry) || expiry <= now + minRemainingMs)) { reasons.push('EXPIRED_OR_TOO_SHORT'); continue; }
        if (request.freshness?.maxInventoryAgeMs !== undefined && (!candidate.createdAt || !Number.isFinite(Date.parse(candidate.createdAt)) || now - Date.parse(candidate.createdAt) > maxInventoryAgeMs)) { reasons.push('INVENTORY_TOO_OLD_OR_UNKNOWN'); continue; }
        const key = connectionKey(candidate.connection);
        if (this.reservations.has(key)) { reasons.push('ALREADY_LEASED'); continue; }
        if (unusedForMs && now - (this.lastUsed.get(key) ?? -Infinity) < unusedForMs) { reasons.push('RECENTLY_USED'); continue; }
        const leaseId = randomUUID();
        // No await between check and set: reservations and exit-IP claims are atomic in this process.
        this.reservations.set(key, leaseId);
        tried++;
        let retained = false;
        try {
          const probeSignal = AbortSignal.any([combined, AbortSignal.timeout(probeTimeoutMs)]);
          const verified = await withSignal(this.probeConnection(candidate.connection, { signal: probeSignal, timeoutMs: probeTimeoutMs }), probeSignal, 'PROBE_TIMEOUT');
          if (!isIP(verified.exitIp) || !Number.isFinite(verified.latencyMs) || verified.latencyMs < 0 || !Number.isFinite(Date.parse(verified.checkedAt))) throw new ProxyError('INVALID_PROBE_RESULT', 'The verifier returned invalid data.');
          if (Date.now() - Date.parse(verified.checkedAt) > maxVerificationAgeMs || Date.parse(verified.checkedAt) > Date.now() + 1000) throw new ProxyError('STALE_VERIFICATION', 'Proxy verification is stale.');
          if (verified.latencyMs > maxLatencyMs) throw new ProxyError('TOO_SLOW', 'Proxy latency exceeded the requested limit.');
          if (expiry !== undefined && expiry <= Date.now() + minRemainingMs) throw new ProxyError('EXPIRED_OR_TOO_SHORT', 'The proxy expired during verification.');
          const verifiedAttributes = sanitizeAttributes(verified.attributes);
          // A verifier's contrary evidence always wins over a declaration.
          for (const attribute of Object.keys(verifiedAttributes) as (keyof ProxyAttributes)[]) {
            if (requestedAttributes[attribute] !== undefined && normalized(attribute, requestedAttributes[attribute]) !== normalized(attribute, verifiedAttributes[attribute])) throw new ProxyError('VERIFIED_ATTRIBUTE_MISMATCH', 'Independently observed proxy attributes differ from the request.');
          }
          for (const attribute of request.requireVerified ?? []) {
            if (verifiedAttributes[attribute] === undefined) throw new ProxyError('ATTRIBUTE_NOT_VERIFIED', 'Required proxy attributes were not independently verified.');
          }
          const exitKey = canonicalIp(verified.exitIp);
          if (this.exitReservations.has(exitKey)) throw new ProxyError('EXIT_IP_IN_USE', 'The exit IP is already assigned to another active run.');
          if (unusedForMs && Date.now() - (this.lastExitUsed.get(exitKey) ?? -Infinity) < unusedForMs) throw new ProxyError('EXIT_IP_RECENTLY_USED', 'The exit IP was used too recently.');
          combined.throwIfAborted();
          const cleanVerification: ProxyProbeResult = { exitIp: verified.exitIp, latencyMs: verified.latencyMs, checkedAt: verified.checkedAt, attributes: verifiedAttributes };
          const report: ProxyReport = {
            leaseId, runId, provider: candidate.provider, candidateId: candidate.id, source: candidate.source,
            protocol: candidate.connection.protocol, declared, verified: cleanVerification,
            allocatedAt: new Date().toISOString(), expiresAt: candidate.expiresAt,
            uniqueness: 'exclusive-within-this-manager-at-allocation',
          };
          const lease: ProxyLease = {
            id: leaseId,
            proxy: { value: candidate.connection.protocol === 'socks5' ? 'socks5' : 'http', extra: { host: candidate.connection.host, port: candidate.connection.port, ...(candidate.connection.username !== undefined ? { id: candidate.connection.username } : {}), ...(candidate.connection.password !== undefined ? { secret: candidate.connection.password } : {}) } },
            report,
          };
          this.exitReservations.set(exitKey, leaseId);
          this.active.set(leaseId, { lease, connectionKey: key, inventoryId: candidate.provider === 'inventory' ? candidate.id : undefined, exitKey });
          this.lastUsed.set(key, Date.now());
          this.lastExitUsed.set(exitKey, Date.now());
          retained = true;
          return lease;
        } catch (error) {
          reasons.push(combined.aborted ? 'ALLOCATION_ABORTED' : safeCode(error));
          if (combined.aborted) break;
        } finally {
          if (!retained && this.reservations.get(key) === leaseId) this.reservations.delete(key);
        }
      }
    } catch (error) { reasons.push(combined.aborted ? 'ALLOCATION_ABORTED' : safeCode(error)); }
    finally { if (iterator.return) void iterator.return().catch(() => undefined); }
    throw new ProxyAllocationError(reasons.slice(-100));
  }

  release(leaseId: string): boolean {
    const owned = this.active.get(leaseId);
    if (!owned) return false;
    this.active.delete(leaseId);
    if (this.reservations.get(owned.connectionKey) === leaseId) this.reservations.delete(owned.connectionKey);
    if (this.exitReservations.get(owned.exitKey) === leaseId) this.exitReservations.delete(owned.exitKey);
    this.lastUsed.set(owned.connectionKey, Date.now());
    this.lastExitUsed.set(owned.exitKey, Date.now());
    return true;
  }

  async publicInventory(): Promise<PublicProxyInventoryEntry[]> {
    const leasedIds = new Set([...this.active.values()].map((entry) => entry.inventoryId));
    return (await this.inventory.entries()).map((entry) => ({
      id: entry.id, source: entry.source, protocol: entry.protocol, attributes: sanitizeAttributes(entry.attributes),
      createdAt: entry.createdAt, expiresAt: entry.expiresAt, enabled: entry.enabled !== false, leased: leasedIds.has(entry.id),
    }));
  }

  /** Health check takes a temporary exclusive lease; it never resets provider sessions. */
  async probe(request: ProxyRequest, signal?: AbortSignal): Promise<ProxyReport> {
    const lease = await this.allocate(request, `probe-${randomUUID()}`, signal);
    try { return lease.report; } finally { this.release(lease.id); }
  }
  async probeInventory(id: string, signal?: AbortSignal): Promise<ProxyReport> {
    return this.probe({ provider: 'inventory', inventoryIds: [id] }, signal);
  }
}
