import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { KameleoEngine } from '../src/engine.js';

test('SDK stop accepts only the specific already-stopped conflict', async () => {
  let code = 'profile_not_running';
  const server = createServer((_request, response) => { response.writeHead(409, { 'content-type': 'application/json' }); response.end(JSON.stringify({ status: 409, errorCode: code })); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    const engine = new KameleoEngine(`http://127.0.0.1:${address.port}`);
    await engine.stop('00000000-0000-0000-0000-000000000001');
    code = 'profile_locked'; await assert.rejects(engine.stop('00000000-0000-0000-0000-000000000001'));
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
