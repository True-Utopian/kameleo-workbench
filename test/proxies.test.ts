import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect, type Socket, type AddressInfo } from 'node:net';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProxyManager, ProxyAllocationError, createHttpsProbe, iproyalLifetimeMs, type ProxyInventoryEntry, type ProxyProbe, type ProxyProvider } from '../src/proxies/index.js';

const connection = { protocol: 'http' as const, host: 'proxy.example.test', port: 1234 };
const observed = (ip = '198.51.100.10', extra = {}) => ({ exitIp: ip, latencyMs: 5, checkedAt: new Date().toISOString(), ...extra });
async function inventory(entries: ProxyInventoryEntry[]) {
  const folder = await mkdtemp(join(tmpdir(), 'workbench-proxies-'));
  const file = join(folder, 'inventory.json');
  await writeFile(file, JSON.stringify({ proxies: entries }));
  return { file, cleanup: () => rm(folder, { recursive: true, force: true }) };
}

async function localProxyFixture(options: { exitIp?: string; delayMs?: number; status?: number } = {}) {
  const sockets = new Set<Socket>();
  let connects = 0;
  let authorization: string | undefined;
  const endpoint = createHttpsServer({ key: TEST_KEY, cert: TEST_CERT }, (_request, response) => {
    const respond = () => { response.writeHead(options.status ?? 200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ ip: options.exitIp ?? '198.51.100.44' })); };
    if (options.delayMs) setTimeout(respond, options.delayMs).unref(); else respond();
  });
  endpoint.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>((resolve) => endpoint.listen(0, '127.0.0.1', resolve));
  const endpointPort = (endpoint.address() as AddressInfo).port;
  const proxy = createHttpServer();
  proxy.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  proxy.on('connect', (request, socket, head) => {
    connects++;
    authorization = request.headers['proxy-authorization'];
    const upstream = connect(endpointPort, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
    sockets.add(upstream);
    upstream.on('close', () => sockets.delete(upstream));
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  return {
    connection: { protocol: 'http' as const, host: '127.0.0.1', port: (proxy.address() as AddressInfo).port, username: 'test-user', password: 'test:p@ss/word' },
    probe: createHttpsProbe({ url: `https://127.0.0.1:${endpointPort}/ip`, ca: TEST_CERT }),
    stats: () => ({ connects, authorization }),
    async close() {
      for (const socket of sockets) socket.destroy();
      await Promise.all([new Promise<void>((resolve) => proxy.close(() => resolve())), new Promise<void>((resolve) => endpoint.close(() => resolve()))]);
    },
  };
}

test('HTTPS verification really traverses CONNECT and preserves encoded credentials', async () => {
  const fixture = await localProxyFixture();
  try {
    const manager = new ProxyManager({ probe: fixture.probe });
    const lease = await manager.allocate({ provider: 'direct', proxy: fixture.connection }, 'run-1');
    assert.equal(lease.report.verified.exitIp, '198.51.100.44');
    assert.equal(fixture.stats().connects, 1);
    assert.equal(fixture.stats().authorization, `Basic ${Buffer.from('test-user:test:p@ss/word').toString('base64')}`);
    assert.equal(lease.proxy.extra.secret, 'test:p@ss/word');
    assert.ok(!JSON.stringify(lease.report).includes('test:p@ss/word'));
    assert.deepEqual(lease.report.verified.attributes, {});
    manager.release(lease.id);
  } finally { await fixture.close(); }
});

test('probe failure, timeout and invalid IP fail closed without leaking credentials', async () => {
  for (const options of [{ status: 503 }, { delayMs: 150 }, { exitIp: 'not-an-ip' }]) {
    const fixture = await localProxyFixture(options);
    try {
      const manager = new ProxyManager({ probe: fixture.probe });
      await assert.rejects(manager.allocate({ provider: 'direct', proxy: fixture.connection, probeTimeoutMs: 30 }, 'run'), (error: unknown) => {
        assert.ok(error instanceof ProxyAllocationError);
        assert.ok(!String(error).includes('test:p@ss/word'));
        return true;
      });
    } finally { await fixture.close(); }
  }
});

test('concurrent exit-IP claims are exclusive even with different proxy credentials', async () => {
  const provider: ProxyProvider = {
    name: 'test',
    async *candidates(_request, context) {
      for (let index = 0; index < context.maxAttempts; index++) yield { id: crypto.randomUUID(), provider: 'test', connection: { ...connection, username: crypto.randomUUID() }, declared: {} };
    },
  };
  const manager = new ProxyManager({ providers: [provider], probe: async () => { await new Promise((resolve) => setTimeout(resolve, 10)); return observed(); } });
  const results = await Promise.allSettled([manager.allocate({ provider: 'test', maxAttempts: 1 }, 'a'), manager.allocate({ provider: 'test', maxAttempts: 1 }, 'b')]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  const winner = results.find((result) => result.status === 'fulfilled');
  assert.ok(winner && winner.status === 'fulfilled');
  assert.equal(manager.release(winner.value.id), true);
  assert.equal(manager.release(winner.value.id), false);
  const later = await manager.allocate({ provider: 'test', maxAttempts: 1 }, 'c');
  manager.release(later.id);
});

test('IPv4-mapped IPv6 cannot evade active exit-IP deduplication', async () => {
  let checks = 0;
  const manager = new ProxyManager({ probe: async () => observed(checks++ ? '::ffff:198.51.100.10' : '198.51.100.10') });
  const first = await manager.allocate({ provider: 'direct', proxy: connection }, 'one');
  await assert.rejects(manager.allocate({ provider: 'direct', proxy: { ...connection, port: 4321 } }, 'two'), /EXIT_IP_IN_USE/);
  manager.release(first.id);
});

test('inventory filters, expiry and public output never reveal credentials', async () => {
  const data = await inventory([
    { id: 'expired', ...connection, expiresAt: new Date(Date.now() - 1000).toISOString(), attributes: { type: 'isp', country: 'GB' } },
    { id: 'wrong-country', ...connection, port: 1235, attributes: { type: 'isp', country: 'US' } },
    { id: 'chosen', source: 'nsocks', ...connection, usernameEnv: 'PROXY_USER', passwordEnv: 'PROXY_PASSWORD', attributes: { type: 'isp', country: 'GB', city: 'London', asn: 'AS123' } },
  ]);
  try {
    let probes = 0;
    const manager = new ProxyManager({ inventoryFile: data.file, env: { PROXY_USER: 'secret-user', PROXY_PASSWORD: 'secret-password' }, probe: async () => { probes++; return observed(); } });
    const lease = await manager.allocate({ provider: 'inventory', type: 'isp', country: 'gb', city: 'london', asn: 123, maxAttempts: 1 }, 'run');
    assert.equal(lease.report.candidateId, 'chosen');
    assert.equal(lease.report.source, 'nsocks');
    assert.equal(lease.proxy.extra.id, 'secret-user');
    assert.equal(probes, 1);
    const publicEntries = await manager.publicInventory();
    assert.equal(publicEntries.find((entry) => entry.id === 'chosen')?.leased, true);
    assert.ok(!JSON.stringify(publicEntries).includes('secret-'));
    assert.ok(!JSON.stringify(publicEntries).includes('PROXY_PASSWORD'));
    assert.equal(lease.report.verified.attributes?.type, undefined);
    manager.release(lease.id);
  } finally { await data.cleanup(); }
});

test('required independent attributes are not satisfied by provider declarations', async () => {
  const manager = new ProxyManager({ probe: async () => observed() });
  await assert.rejects(manager.allocate({ provider: 'direct', proxy: connection, type: 'residential', country: 'GB', requireVerified: ['country', 'type'] }, 'run'), /ATTRIBUTE_NOT_VERIFIED/);
  const contradicting = new ProxyManager({ probe: async () => observed('198.51.100.8', { attributes: { country: 'US' } }) });
  await assert.rejects(contradicting.allocate({ provider: 'direct', proxy: connection, country: 'GB' }, 'run'), /VERIFIED_ATTRIBUTE_MISMATCH/);
});

test('stale, slow and recently used proxies are rejected; aborted allocation releases reservations', async () => {
  for (const result of [observed('198.51.100.1', { latencyMs: 100 }), observed('198.51.100.1', { checkedAt: new Date(Date.now() - 60_000).toISOString() })]) {
    const manager = new ProxyManager({ probe: async () => result });
    await assert.rejects(manager.allocate({ provider: 'direct', proxy: connection, maxLatencyMs: 50 }, 'run'), /TOO_SLOW|STALE_VERIFICATION/);
  }
  let stall = true;
  const manager = new ProxyManager({ probe: async () => stall ? new Promise(() => {}) : observed() });
  await assert.rejects(manager.allocate({ provider: 'direct', proxy: connection, timeoutMs: 30 }, 'run'), /ALLOCATION_ABORTED/);
  stall = false;
  const lease = await manager.allocate({ provider: 'direct', proxy: connection }, 'next');
  manager.release(lease.id);
  await assert.rejects(manager.allocate({ provider: 'direct', proxy: connection, freshness: { unusedForMs: 1000 } }, 'fresh'), /RECENTLY_USED/);
});

test('IPRoyal produces documented sticky credentials, tracks TTL and never calls purchase APIs', async () => {
  const connections: unknown[] = [];
  const manager = new ProxyManager({ env: { IPROYAL_PROXY_USERNAME: 'account', IPROYAL_PROXY_PASSWORD: 'base-secret' }, probe: async (proxy) => { connections.push(proxy); return observed(); } });
  const lease = await manager.allocate({ provider: 'iproyal', country: 'GB', city: 'london', type: 'residential', iproyal: { lifetime: '30m' } }, 'run');
  assert.match(lease.proxy.extra.secret!, /^base-secret_country-gb_city-london_session-[a-f0-9]{8}_lifetime-30m_killswitch-1$/);
  assert.equal(lease.proxy.extra.host, 'geo.iproyal.com');
  assert.equal(lease.proxy.extra.port, 12321);
  assert.ok(Date.parse(lease.report.expiresAt!) > Date.now() + 29 * 60_000);
  assert.equal(lease.report.declared.type, 'residential');
  assert.equal(lease.report.verified.attributes?.type, undefined);
  assert.ok(!JSON.stringify(lease.report).includes('base-secret'));
  manager.release(lease.id);
  await assert.rejects(manager.allocate({ provider: 'iproyal', asn: 123 }, 'asn'), /UNSUPPORTED_FILTER/);
  assert.equal(iproyalLifetimeMs('7d'), 604_800_000);
  assert.throws(() => iproyalLifetimeMs('60m'), /unit limit/);
  assert.equal(connections.length, 1);
});

test('custom provider attempts and error text are bounded and sanitized', async () => {
  let attempts = 0;
  const provider: ProxyProvider = { name: 'custom', async *candidates() { while (true) yield { id: 'candidate', provider: 'custom', connection, declared: {} }; } };
  const manager = new ProxyManager({ providers: [provider], probe: async () => { attempts++; throw new Error('password=do-not-leak'); } });
  await assert.rejects(manager.allocate({ provider: 'custom', maxAttempts: 3 }, 'run'), (error) => {
    assert.ok(!String(error).includes('do-not-leak'));
    return true;
  });
  assert.equal(attempts, 3);
});

test('minimum remaining lifetime rejects unknown expiry and custom probe deadlines are enforced', async () => {
  const manager = new ProxyManager({ probe: async () => observed() });
  await assert.rejects(manager.allocate({ provider: 'direct', proxy: connection, minRemainingMs: 1000 }, 'run'), /EXPIRY_UNKNOWN/);
  const hung = new ProxyManager({ probe: async () => new Promise(() => {}) });
  await assert.rejects(hung.allocate({ provider: 'direct', proxy: connection, probeTimeoutMs: 20, timeoutMs: 1000 }, 'run'), /PROBE_TIMEOUT/);
});

test('health probe releases the lease, but expiry never releases an active run implicitly', async () => {
  const data = await inventory([{ id: 'one', ...connection, expiresAt: new Date(Date.now() + 300).toISOString() }]);
  try {
    const manager = new ProxyManager({ inventoryFile: data.file, probe: async () => observed() });
    await manager.probeInventory('one');
    assert.equal((await manager.publicInventory())[0]?.leased, false);
    const lease = await manager.allocate({ provider: 'inventory' }, 'run');
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal((await manager.publicInventory())[0]?.leased, true);
    manager.release(lease.id);
    await assert.rejects(manager.allocate({ provider: 'inventory' }, 'expired'), /EXPIRED_OR_TOO_SHORT/);
  } finally { await data.cleanup(); }
});

// Public localhost-only fixture, never a real credential. Embedded to keep tests independent of OpenSSL installations.
const TEST_KEY = "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDZhI748UPr1vFg\nVgFqgrzNwJWUmz2BhboQVXh5xVqZlfiwqz2Md4pBIbOl0TgSS1T6rjrTt/kP/dTq\nUAHiN1edm74zh36C4cvMB4G1F2FyBydYpBh2EXg3uPpSJth1Civ+lwMC1ZcDoMSr\n9ZwUVko6F+/tPy/zWS0r6XbPHoXFoR8MYMLzxwJaBr80hk0FyNS9Kw0MhYQvrlY6\nY9jcBxWeaBPFeHCmnxPjzJkojCZbyT1dQdZ3jhYzDI76nRsICt11KzvKQ9lv17qS\nJH7l9yLW2OPZf9Hgek1lyO8kgxmDayMs9V2+ZDgZHjMPj6TiFo06CrkGMfWSu8OG\nIaVKU/2XAgMBAAECggEAHuL90kegF2sMF1vfE5rA6I6CLvnkP/IXO56HXvMxLEHp\ncFzAfqOy1BDPC6qrxZ1A0d/PpqSnDyhCBYua2N526IBm/7YrtrYNVEl0l5xcT+7I\nHYQfnRRZ97+ie+vcLLJnEN2spchiizdW9fwIT7L5E0q23P9t9aYiDew23K4+3JMD\nXGlVyZhWH0eFCUXXvLGsTosc6MWOAdxtzroN8L+hQwsCUj/OQ/6m1W6tzvGBfEs1\nKg+qz0/jmPl3DbiPmUEb1n9zcDrUaq1NFTi3aRMpyx8FAkM9ewdldRy9YHpz2p/o\nhNXLskqyMeneVm93Fpsz+ZmKgpiQZz4y8gG8q6oEEQKBgQD2EkGLXfdc1RcYyqTn\n3oq6LppVVfgKruYyToZg5hiCdLOy/eWKP2n5x5L3hWDEVedAO+7Yz7TZp+Gw9izK\nz/8KXriZXT/nONS+m1tcxhFYn9UdNBwDWGnErQksj2di4nxKUKthPj4gZiX4u1ha\nw7/PO/X5BbNO1nkRX48YGZK4KwKBgQDiS11h3mB2YRL2jaxUabiL/6TQeXg3VQfA\nJDUmPIg9l0slRS1SdurcDB5A0Mxo2ctH+aIVSVzs2nl80ow58Q2cMLYImoIV00Vz\n8cjXQB9ewaNvdjt8RZQRwhjEJPxYBcm7vEJ9Pa0J+5eNyIevL2Lwsn/QAiu2Fz6C\nY5+8viIORQKBgQDV4OpNe4AclS59Iu2QiBKmXwlP8OgmSPzWbwBHytc01MC4bAyO\nTC4Np9TrBWglXtEgOLeShX6YzF3TlTU7luwDlG75Bl8b1366qYgQrCu5jzsKJhfP\nJJLSGuBldcOT5G3JnjJH1HTlbkPE3Pmf8pKOSnyyVK0UckBKxHc4qEmpfwKBgHL4\n2XQM+LOMdIcByemFYTb35rPo0zRBplNv0fUgUhQA1zQTZoh8VK0CFyjVLNWkugxS\nf5ATGvxXr9vEWWxi1Yhik0nhvm/6TFIxKNp8ALQy66eIyYZFD4rKM60MIY1TO4B/\nkMRy3oSw5/ooRQ+zorAp8JgtUioMuzyiAxlw/HqFAoGBAI/vfcDxs2mLYeno+G52\ncehg8EUegtyuShCuM/KSRf+O6lEZ0AzzqF84OVeUHwLbm8aOYam/iytWJm6T3yIp\ndowsrtkLw5edp6eTCAHhPm0x96y2+JnkTEWyM0VikO8XtXxtqdHKj0TGpcy28csL\nWvgAVVoAuhW3/SAtziwGN2nY\n-----END PRIVATE KEY-----\n";
const TEST_CERT = "-----BEGIN CERTIFICATE-----\nMIIDJTCCAg2gAwIBAgIUJ8WP+jZ2IaGXdl512bfhbIgCTrEwDQYJKoZIhvcNAQEL\nBQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MTAwMTIyMTk0OVoXDTM2MDky\nODIyMTk0OVowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF\nAAOCAQ8AMIIBCgKCAQEA2YSO+PFD69bxYFYBaoK8zcCVlJs9gYW6EFV4ecVamZX4\nsKs9jHeKQSGzpdE4EktU+q4607f5D/3U6lAB4jdXnZu+M4d+guHLzAeBtRdhcgcn\nWKQYdhF4N7j6UibYdQor/pcDAtWXA6DEq/WcFFZKOhfv7T8v81ktK+l2zx6FxaEf\nDGDC88cCWga/NIZNBcjUvSsNDIWEL65WOmPY3AcVnmgTxXhwpp8T48yZKIwmW8k9\nXUHWd44WMwyO+p0bCArddSs7ykPZb9e6kiR+5fci1tjj2X/R4HpNZcjvJIMZg2sj\nLPVdvmQ4GR4zD4+k4haNOgq5BjH1krvDhiGlSlP9lwIDAQABo28wbTAdBgNVHQ4E\nFgQUj0pTbK2LXsac+Fl5v7kD5FFn1NQwHwYDVR0jBBgwFoAUj0pTbK2LXsac+Fl5\nv7kD5FFn1NQwDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SH\nBH8AAAEwDQYJKoZIhvcNAQELBQADggEBAFz4bljZ6K3LsRUKm3FSgHa7TOzICDwx\nRUXc6nXTjwRFJLpyaMqV2h+SWijVx6JfRtNPSC8Pl/fsPx1FpzFhc+Lu6LlI2I9t\n0CjYuF1a7Y86Dy4TzFv+OWIBVZ3GJdbLUHscb46Q9jWz2jwvynZQ49ti11IiuL4x\n6yEx7C+/1i1mvkObpQaH5CAST67OD6EQyyifrqUAjzdIRX2VFz4jrow8KQ6AnSRP\n51+spz0byGFeaGPqwZ6/YkH1HGwo/ZJZEC6/YSWBIy0hnXnYVa9nTkeQBB4w3yw0\n+M0VegEG05KPDE7rcBaRaXRs+884Ag2Fr+uay5UkLBgJoiqzJqoxD3g=\n-----END CERTIFICATE-----\n";
