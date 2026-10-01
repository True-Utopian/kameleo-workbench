export type ProxyType = 'residential' | 'isp' | 'datacenter' | 'mobile';
/** https means an HTTP CONNECT proxy supporting HTTPS destinations, not TLS to the proxy. */
export type ProxyProtocol = 'http' | 'https' | 'socks5';
export interface ProxyAttributes {
  type?: ProxyType;
  country?: string;
  region?: string;
  state?: string;
  city?: string;
  isp?: string;
  asn?: string | number;
}
export interface ProxyConnectionInput {
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username?: string;
  password?: string;
  usernameEnv?: string;
  passwordEnv?: string;
}
export interface ProxyConnection {
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username?: string;
  password?: string;
}
export interface ProxyInventoryEntry extends ProxyConnectionInput {
  id: string;
  /** e.g. static, nsocks. A label, not an API integration or independent verification. */
  source?: string;
  attributes?: ProxyAttributes;
  createdAt?: string;
  expiresAt?: string;
  enabled?: boolean;
}
export interface ProxyRequest extends ProxyAttributes {
  provider: string;
  protocol?: ProxyProtocol;
  inventoryIds?: string[];
  proxy?: ProxyConnectionInput;
  maxLatencyMs?: number;
  maxAttempts?: number;
  timeoutMs?: number;
  probeTimeoutMs?: number;
  minRemainingMs?: number;
  /** These fields must be confirmed by a configured independent probe, not provider labels. */
  requireVerified?: (keyof ProxyAttributes)[];
  freshness?: { maxVerificationAgeMs?: number; maxInventoryAgeMs?: number; unusedForMs?: number };
  iproyal?: { lifetime?: string };
}
export interface ProxyCandidate {
  id: string;
  provider: string;
  source?: string;
  connection: ProxyConnection;
  declared: ProxyAttributes;
  createdAt?: string;
  expiresAt?: string;
}
export interface ProxyProbeResult {
  exitIp: string;
  latencyMs: number;
  checkedAt: string;
  /** Only attributes actually obtained from your independent verification service. */
  attributes?: ProxyAttributes;
}
export type ProxyProbe = (connection: ProxyConnection, options: { signal: AbortSignal; timeoutMs: number }) => Promise<ProxyProbeResult>;
export interface ProxyProviderContext { signal: AbortSignal; maxAttempts: number }
export interface ProxyProvider {
  readonly name: string;
  candidates(request: ProxyRequest, context: ProxyProviderContext): AsyncIterable<ProxyCandidate>;
}
export interface KameleoProxyChoice {
  value: 'http' | 'socks5';
  extra: { host: string; port: number; id?: string; secret?: string };
}
export interface ProxyReport {
  leaseId: string;
  runId: string;
  provider: string;
  candidateId: string;
  source?: string;
  protocol: ProxyProtocol;
  declared: ProxyAttributes;
  verified: ProxyProbeResult;
  allocatedAt: string;
  expiresAt?: string;
  uniqueness: 'exclusive-within-this-manager-at-allocation';
}
export interface ProxyLease {
  id: string;
  /** Contains credentials: never serialize into public state/logs. */
  proxy: KameleoProxyChoice;
  report: ProxyReport;
}
export interface PublicProxyInventoryEntry {
  id: string;
  source?: string;
  protocol: ProxyProtocol;
  attributes: ProxyAttributes;
  createdAt?: string;
  expiresAt?: string;
  enabled: boolean;
  leased: boolean;
}
export class ProxyError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'ProxyError'; }
}
