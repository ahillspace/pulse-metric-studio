import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { guardedFetch, publicOnlyLookup } from './guarded-fetch.js';
import { assertSafeLlmEndpoint, UnsafeLlmEndpointError } from './network-policy.js';

let server: http.Server;
let port = 0;
before(async () => {
  server = http.createServer((request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(302, { Location: 'http://example.test/' }).end();
      return;
    }
    if (request.url === '/slow') return;
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      response.writeHead(201, { 'Content-Type': 'application/json', 'X-Echo': String(request.headers['x-test'] ?? '') });
      response.end(JSON.stringify({ method: request.method, body }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

const toLoopback = (_hostname: string, callback: (error: NodeJS.ErrnoException | null, addresses: { address: string; family: number }[]) => void) =>
  callback(null, [{ address: '127.0.0.1', family: 4 }]);

test('a rebinding resolver that passes the endpoint check is still refused at connect time', async () => {
  let calls = 0;
  const rebinding = (_hostname: string, callback: (error: NodeJS.ErrnoException | null, addresses: { address: string; family: number }[]) => void) => {
    calls += 1;
    callback(null, [{ address: calls === 1 ? '93.184.216.34' : '127.0.0.1', family: 4 }]);
  };
  await assert.doesNotReject(assertSafeLlmEndpoint('https://gateway.example.test/v1', false, async (hostname) =>
    new Promise((resolve) => rebinding(hostname, (_error, addresses) => resolve(addresses)))));
  await assert.rejects(guardedFetch(false, rebinding)(`http://gateway.example.test:${port}/v1`, { method: 'POST', body: '{}' }),
    (error: unknown) => error instanceof UnsafeLlmEndpointError);
});

test('the connect-time lookup honours address family and all-address requests', async () => {
  const lookup = publicOnlyLookup((_hostname, callback) => callback(null, [
    { address: '93.184.216.34', family: 4 },
    { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
  ]));
  const single = await new Promise<[string, number | undefined]>((resolve, reject) =>
    lookup('host', { family: 6 }, (error, address, family) => (error ? reject(error) : resolve([String(address), family]))));
  assert.deepEqual(single, ['2606:2800:220:1:248:1893:25c8:1946', 6]);
  const all = await new Promise<unknown>((resolve, reject) =>
    lookup('host', { all: true }, (error, addresses) => (error ? reject(error) : resolve(addresses))));
  assert.equal((all as unknown[]).length, 2);
});

test('guarded requests send headers and bodies and return a standard response', async () => {
  const send = guardedFetch(false, toLoopback, () => true);
  const response = await send(`http://gateway.example.test:${port}/v1`, { method: 'POST', headers: { 'X-Test': 'yes' }, body: '{"a":1}' });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('x-echo'), 'yes');
  assert.deepEqual(await response.json(), { method: 'POST', body: '{"a":1}' });
});

test('guarded requests never follow redirects and honour abort deadlines', async () => {
  const send = guardedFetch(false, toLoopback, () => true);
  await assert.rejects(send(`http://gateway.example.test:${port}/redirect`, { redirect: 'error' }), /redirects are not followed/);
  await assert.rejects(send(`http://gateway.example.test:${port}/slow`, { signal: AbortSignal.timeout(50) }),
    (error: unknown) => error instanceof Error && error.name === 'TimeoutError');
});
