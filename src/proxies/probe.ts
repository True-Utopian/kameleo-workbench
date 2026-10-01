import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { ProxyError, type ProxyProbe, type ProxyAttributes } from './types.js';

export interface HttpsProbeOptions {
  /** HTTPS endpoint returning {ip: string}; redirects are deliberately not followed. */
  url?: string;
  /** Private test/enterprise CA; TLS validation always stays enabled. */
  ca?: string | Buffer;
  parse?: (body: unknown) => { ip: string; attributes?: ProxyAttributes };
}

export function createHttpsProbe(options: HttpsProbeOptions = {}): ProxyProbe {
  const endpoint = new URL(options.url ?? 'https://api.ipify.org?format=json');
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) {
    throw new ProxyError('INVALID_PROBE_URL', 'Proxy verification requires a credential-free HTTPS URL.');
  }
  return async (connection, { signal, timeoutMs }) => {
    const address = new URL(`${connection.protocol === 'socks5' ? 'socks5h' : 'http'}://localhost`);
    address.hostname = connection.host.includes(':') ? `[${connection.host.replace(/^\[|\]$/g, '')}]` : connection.host;
    address.port = String(connection.port);
    if (connection.username !== undefined) address.username = connection.username;
    if (connection.password !== undefined) address.password = connection.password;
    const agent = connection.protocol === 'socks5' ? new SocksProxyAgent(address) : new HttpsProxyAgent(address);
    const started = performance.now();
    const combinedSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    try {
      const body = await new Promise<string>((resolve, reject) => {
        const request = httpsRequest(endpoint, {
          agent, signal: combinedSignal, ca: options.ca,
          headers: { accept: 'application/json', 'user-agent': 'kameleo-workbench/proxy-check' },
        }, (response) => {
          if (response.statusCode !== 200) {
            response.resume();
            reject(new ProxyError('PROBE_HTTP_ERROR', 'The proxy verification endpoint did not return success.'));
            return;
          }
          let length = 0;
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => {
            length += chunk.length;
            if (length > 32_768) { response.destroy(); reject(new ProxyError('PROBE_TOO_LARGE', 'Proxy verification response exceeded its size limit.')); }
            else chunks.push(chunk);
          });
          response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
          response.on('error', reject);
        });
        request.on('error', reject);
        request.end();
      });
      const raw: unknown = JSON.parse(body);
      const parsed = options.parse ? options.parse(raw) : { ip: (raw as { ip?: unknown })?.ip };
      if (typeof parsed.ip !== 'string' || !isIP(parsed.ip)) {
        throw new ProxyError('INVALID_EXIT_IP', 'Proxy verification did not return a valid exit IP.');
      }
      return { exitIp: parsed.ip, latencyMs: Math.round(performance.now() - started), checkedAt: new Date().toISOString(), attributes: 'attributes' in parsed ? parsed.attributes : undefined };
    } catch (error) {
      if (error instanceof ProxyError) throw error;
      if (combinedSignal.aborted) throw new ProxyError('PROBE_TIMEOUT', 'Proxy verification was cancelled or timed out.');
      throw new ProxyError('PROBE_FAILED', 'Could not verify the proxy over HTTPS.');
    } finally { agent.destroy(); }
  };
}
