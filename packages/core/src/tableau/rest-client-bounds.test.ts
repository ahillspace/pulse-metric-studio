import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { DEFAULT_MAX_RESPONSE_BYTES, getJson, postJson, TableauError, type TableauSession } from './rest-client.js';
import { discoverRestApiVersion, FALLBACK_API_VERSION } from './signin.js';
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const session: TableauSession = { serverUrl: 'https://example.test', siteContentUrl: 'site', siteId: 'site', userId: 'user', token: 'test', apiVersion: '3.29' };

test('opt-in JSON byte limit cancels a streamed body without content-length', async () => {
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(17)); },
    cancel() { cancelled = true; },
  }));
  await assert.rejects(getJson(session, '/api/-/fixture', undefined, 100, 16), /exceeds the permitted size/);
  assert.equal(cancelled, true);
});

test('opt-in bounded JSON body has a deadline even if headers have already arrived', async () => {
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  await assert.rejects(postJson(session, '/api/-/fixture', {}, { maxResponseBytes: 1024, timeoutMs: 20 }),
    (error: unknown) => error instanceof TableauError && error.kind === 'network' && /body timed out/.test(error.message));
  assert.equal(cancelled, true);
});

test('bounded JSON reads valid response exactly at its byte limit', async () => {
  globalThis.fetch = async () => new Response('{"ok":true}');
  assert.deepEqual(await getJson(session, '/api/-/fixture', undefined, 100, 11), { ok: true });
});

test('Tableau reads without an explicit limit still stop at the default size cap', async () => {
  globalThis.fetch = async () => new Response('{}', { headers: { 'content-length': String(DEFAULT_MAX_RESPONSE_BYTES + 1) } });
  await assert.rejects(getJson(session, '/api/-/fixture'), /exceeds the permitted size/);
});

test('Tableau error snippets never reflect the session token', async () => {
  const tokenSession = { ...session, token: 'session-token-value' };
  globalThis.fetch = async () => Response.json({ error: { detail: 'Token session-token-value is not valid here.' } }, { status: 400 });
  await assert.rejects(getJson(tokenSession, '/api/-/fixture'), (error: unknown) =>
    error instanceof TableauError && !error.bodySnippet.includes('session-token-value') && error.bodySnippet.includes('[redacted]'));
  await assert.rejects(postJson(tokenSession, '/api/-/fixture', {}), (error: unknown) =>
    error instanceof TableauError && !error.bodySnippet.includes('session-token-value'));
});

test('version diagnostics enforce the caller body limit before retrying', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls > 1) return Response.json({ ok: true });
    return new Response('404003 ' + 'x'.repeat(64), { status: 404 });
  };
  await assert.rejects(getJson({ ...session }, '/api/3.29/fixture', undefined, 100, 16), /exceeds the permitted size/);
  assert.equal(calls, 1);
});

test('version diagnostics have a body deadline and cancel the original stream', async () => {
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 404 });
  await assert.rejects(getJson({ ...session }, '/api/3.29/fixture', undefined, 20, 64),
    (error: unknown) => error instanceof TableauError && error.kind === 'network' && /body timed out/.test(error.message));
  assert.equal(cancelled, true);
});

test('bounded version diagnostics preserve version recovery and ordinary HTTP errors', async () => {
  const paths: string[] = [];
  globalThis.fetch = async (input) => {
    paths.push(String(input));
    return paths.length === 1 ? new Response('404003 Unknown resource', { status: 404 }) : Response.json({ ok: true });
  };
  const owner = { ...session };
  assert.deepEqual(await getJson(owner, '/api/3.29/fixture', undefined, 100, 64), { ok: true });
  assert.equal(owner.apiVersion, '3.27');
  assert.match(paths[1], /\/api\/3\.27\/fixture$/);

  globalThis.fetch = async () => Response.json({ error: { code: '404001' } }, { status: 404, headers: { validation_code: 'missing' } });
  await assert.rejects(getJson({ ...session }, '/api/3.29/fixture', undefined, 100, 64), (error: unknown) =>
    error instanceof TableauError && error.status === 404 && error.kind === 'http' && error.bodySnippet.includes('404001') && error.message.includes('missing'));
});

test('server-info discovery rejects an oversized body and retains its fallback policy', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ serverInfo: { restApiVersion: { number: '3.29' } } }), {
    headers: { 'content-length': String(1024 * 1024 + 1) },
  });
  assert.equal(await discoverRestApiVersion('https://example.test'), FALLBACK_API_VERSION);
});
