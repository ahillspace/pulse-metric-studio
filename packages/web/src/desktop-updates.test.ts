import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldPrompt, subscribeUpdates, type UpdateEvents, type UpdateStatus } from './desktop-updates';

const current: UpdateStatus = { currentVersion: '0.1.2', availableVersion: null, lastError: null };
const available: UpdateStatus = { ...current, availableVersion: '0.1.3' };

function fixture(native = true) {
  let handler: ((status: UpdateStatus) => void) | null = null;
  const order: string[] = [];
  let stopped = 0;
  const events: UpdateEvents = {
    native: () => native,
    listen: async (next) => { order.push('listen'); handler = next; return () => { stopped++; }; },
    status: async () => { order.push('status'); return current; },
    apply: async () => {},
  };
  return { events, order, emit: (status: UpdateStatus) => handler!(status), stopped: () => stopped };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('the status is read after listening, then follows desktop checks until cleanup', async () => {
  const f = fixture();
  const seen: UpdateStatus[] = [];
  const stop = subscribeUpdates((status) => seen.push(status), f.events);
  await settle();
  assert.deepEqual(f.order, ['listen', 'status']);
  f.emit(available);
  assert.deepEqual(seen, [current, available]);
  stop();
  f.emit(current);
  assert.equal(seen.length, 2);
  assert.equal(f.stopped(), 1);
});

test('a cleanup before the listener is ready still unsubscribes it', async () => {
  const f = fixture();
  const seen: UpdateStatus[] = [];
  subscribeUpdates((status) => seen.push(status), f.events)();
  await settle();
  assert.equal(f.stopped(), 1);
  assert.deepEqual(seen, []);
});

test('the browser build has no updater', async () => {
  const f = fixture(false);
  subscribeUpdates(() => assert.fail('no status in the browser'), f.events)();
  await settle();
  assert.deepEqual(f.order, []);
});

test('each newly found version prompts once', () => {
  assert.equal(shouldPrompt(null, null), false);
  assert.equal(shouldPrompt(current, null), false);
  assert.equal(shouldPrompt(available, null), true);
  assert.equal(shouldPrompt(available, '0.1.3'), false);
  assert.equal(shouldPrompt({ ...available, availableVersion: '0.1.4' }, '0.1.3'), true);
});
