import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config, tableauFetch } from '@pulse-metric-studio/core';
import { buildApp } from './app.js';

function capture() {
  const lines: string[] = [];
  return {
    stream: { write(message: string) { lines.push(message); } },
    events: () => lines.flatMap((line) => line.trim().split('\n').map((entry) => JSON.parse(entry) as Record<string, unknown>)),
    text: () => lines.join(''),
  };
}

test('API completion keeps status, timing and a server-generated request ID without query, headers or bodies', async () => {
  const logs = capture();
  const app = buildApp({ registerPulseRoutes(instance) {
    instance.post('/api/pulse/metrics', async () => ({ result: 'PRIVATE_RESPONSE' }));
  } }, { logStream: logs.stream });
  try {
    await app.inject({ method: 'POST', url: '/api/pulse/metrics?value=PRIVATE_QUERY',
      headers: { 'request-id': 'UNTRUSTED_REQUEST_ID', authorization: 'Bearer PRIVATE_TOKEN', cookie: 'PRIVATE_COOKIE' },
      payload: { filter: 'PRIVATE_BODY' } });
    const events = logs.events().filter((event) => event.event === 'app.request');
    assert.equal(events.length, 1);
    assert.equal(events[0]!.path, '/api/pulse/metrics');
    assert.equal(events[0]!.method, 'POST');
    assert.equal(events[0]!.status, 200);
    assert.equal(typeof events[0]!.durationMs, 'number');
    assert.match(String(events[0]!.reqId), /^[0-9a-f-]{36}$/);
    assert.doesNotMatch(logs.text(), /PRIVATE_|UNTRUSTED_REQUEST_ID/);
    assert.doesNotMatch(logs.text(), /incoming request|request completed/);
  } finally { await app.close(); }
});

test('API completion applies central redaction to route parameters and unmatched paths', async () => {
  const logs = capture();
  const app = buildApp({ registerPulseRoutes(instance) {
    instance.get('/api/pulse/metrics/:id', async () => ({ ok: true }));
  } }, { logStream: logs.stream });
  try {
    await app.inject('/api/pulse/metrics/PRIVATE_PATH_PARAMETER?value=PRIVATE_QUERY');
    await app.inject('/api/PRIVATE_UNKNOWN_PATH');
    const events = logs.events().filter((event) => event.event === 'app.request');
    assert.equal(events.length, 2);
    assert.equal(events[0]!.path, '/api/pulse/metrics/:id');
    assert.equal(events[1]!.status, 404);
    assert.doesNotMatch(logs.text(), /PRIVATE_/);
  } finally { await app.close(); }
});

test('successful readiness polls are quiet while failed polls retain their diagnostic completion', async () => {
  const logs = capture();
  const app = buildApp({ registerPulseRoutes(instance) {
    instance.get('/api/pulse/status', async () => ({ enabled: true }));
    instance.get('/api/desktop/ready', async (request, reply) => {
      if ((request.query as { fail?: string }).fail) reply.code(503);
      return { ready: true };
    });
  } }, { logStream: logs.stream });
  try {
    await app.inject('/api/desktop/ready?challenge=PRIVATE_CHALLENGE');
    await app.inject('/api/pulse/status');
    await app.inject('/api/tableau/status?restore=false');
    await app.inject('/api/llm/status');
    assert.equal(logs.events().filter((event) => event.event === 'app.request').length, 0);
    await app.inject('/api/desktop/ready?fail=PRIVATE_FAILURE');
    const events = logs.events().filter((event) => event.event === 'app.request');
    assert.equal(events.length, 1);
    assert.equal(events[0]!.status, 503);
    assert.equal(events[0]!.path, '/api/desktop/ready');
    assert.doesNotMatch(logs.text(), /PRIVATE_/);
  } finally { await app.close(); }
});

test('concurrent Tableau calls retain the triggering API request at info even with an error-level server logger', async (t) => {
  const logs = capture();
  const previousLevel = config.logLevel;
  config.logLevel = 'error';
  const app = buildApp({ registerPulseRoutes(instance) {
    for (const action of ['metrics', 'definitions']) {
      instance.post(`/api/pulse/${action}`, async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        await tableauFetch({ serverUrl: 'https://tableau.example.test', siteContentUrl: '', siteId: 'site',
          userId: 'user', token: 'PRIVATE_TOKEN', apiVersion: '3.27' },
        `/api/-/pulse/${action}?filter=PRIVATE_FILTER`,
        { method: 'POST', body: '{"filter":"PRIVATE_BODY"}' });
        return { ok: true };
      });
    }
  } }, { logStream: logs.stream });
  config.logLevel = previousLevel;
  t.mock.method(globalThis, 'fetch', async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    return new Response('{}', { status: 200 });
  });
  try {
    await Promise.all(['metrics', 'definitions'].map((action) => app.inject({ method: 'POST', url: `/api/pulse/${action}?value=PRIVATE_QUERY` })));
    const events = logs.events();
    const attempts = events.filter((event) => event.event === 'tableau.attempt');
    assert.equal(attempts.length, 2);
    for (const action of ['metrics', 'definitions']) {
      const completion = events.find((event) => event.event === 'app.request' && event.path === `/api/pulse/${action}`);
      assert.ok(completion);
      const attempt = attempts.find((event) => event.reqId === completion.reqId);
      assert.ok(attempt);
      assert.equal(attempt.appPath, `/api/pulse/${action}`);
      assert.equal(attempt.appMethod, 'POST');
      assert.equal(attempt.level, 30);
      assert.equal(attempt.path, `/api/-/pulse/${action}`);
    }
    assert.doesNotMatch(logs.text(), /PRIVATE_/);
  } finally { await app.close(); }
});
