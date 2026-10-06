import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { getJson, postJson, TableauError, type TableauSession } from './rest-client.js';
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
