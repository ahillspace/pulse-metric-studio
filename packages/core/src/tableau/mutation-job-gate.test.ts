import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { postJson, TableauMutationStoppedError, type TableauSession } from './rest-client.js';
import { runTableauMutationJob, type TableauMutationJob } from './mutation-pacing.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const session = (userId: string): TableauSession => ({ serverUrl: 'https://fixture.example.test', siteContentUrl: '', siteId: 'site', userId, token: 'fixture-token', apiVersion: '3.27' });
const limited = () => new Response(JSON.stringify({ error: 'limited' }), { status: 429, headers: { 'Retry-After': '0', 'Content-Type': 'application/json' } });
const ok = () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });

function job() {
  const controller = new AbortController();
  const seen = { throttled: 0 };
  const value: TableauMutationJob = {
    signal: controller.signal,
    throttled: () => { seen.throttled++; },
    total: () => {},
    completed: () => {},
  };
  return { value, controller, seen };
}

test('inside a job a write resends past the plain-request retry limit until Tableau accepts it', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
  let attempts = 0;
  globalThis.fetch = async () => (++attempts <= 6 ? limited() : ok());
  const running = job();
  let done = false;
  const write = runTableauMutationJob(running.value, () => postJson(session('job-unbounded'), '/api/-/pulse/write', {}, { timeoutMs: 50 })).finally(() => { done = true; });
  for (let step = 0; step < 400 && !done; step++) {
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    t.mock.timers.tick(250);
  }
  await write;
  assert.equal(attempts, 7, 'Six throttled answers are waited out; a plain request gives up after four retries.');
  assert.ok(running.seen.throttled >= 6);
});

test('stopping a job rejects a write waiting out a throttle as not sent, without resending it', async () => {
  let attempts = 0;
  globalThis.fetch = async () => { attempts++; return new Response('{}', { status: 429, headers: { 'Retry-After': '60' } }); };
  const running = job();
  const write = runTableauMutationJob(running.value, () => postJson(session('job-cancel'), '/api/-/pulse/write', {}));
  while (running.seen.throttled === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  running.controller.abort('cancelled');
  const error = await write.then(() => undefined, (caught: unknown) => caught);
  assert.ok(error instanceof TableauMutationStoppedError, String(error));
  assert.equal(error.sent, false);
  assert.equal(error.reason, 'cancelled');
  assert.match(error.message, /cancelled/);
  assert.equal(attempts, 1);
});

test('stopping a job never aborts a write Tableau is already processing', async () => {
  let release!: () => void;
  let started!: () => void;
  const dispatched = new Promise<void>((resolve) => { started = resolve; });
  let abortedWhileProcessing = false;
  let fetchSignal: AbortSignal | undefined;
  globalThis.fetch = async (_input, init) => {
    fetchSignal = init?.signal ?? undefined;
    started();
    await new Promise<void>((resolve) => { release = resolve; });
    return ok();
  };
  const running = job();
  const write = runTableauMutationJob(running.value, () => postJson(session('job-in-flight'), '/api/-/pulse/write', {}));
  await dispatched;
  running.controller.abort('time_limit');
  await new Promise((resolve) => setTimeout(resolve, 10));
  abortedWhileProcessing = fetchSignal!.aborted;
  release();
  await write;
  assert.equal(abortedWhileProcessing, false);
});
