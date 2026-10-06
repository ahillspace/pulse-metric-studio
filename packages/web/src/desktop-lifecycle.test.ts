import assert from 'node:assert/strict';
import test from 'node:test';
import { subscribeBackendUnavailable } from './desktop-lifecycle';

test('native backend events reach the shell and stop after cleanup', async () => {
  let emit!: (payload: { message?: string }) => void;
  let stopped = 0;
  const messages: string[] = [];
  const cleanup = subscribeBackendUnavailable((message) => messages.push(message), {
    native: () => true,
    listen: async (handler) => { emit = handler; return () => { stopped++; }; },
  });
  await Promise.resolve();
  emit({ message: 'Service exited' });
  assert.deepEqual(messages, ['Service exited']);
  cleanup(); cleanup();
  emit({ message: 'Late event' });
  assert.equal(stopped, 1);
  assert.equal(messages.length, 1);
});

test('StrictMode cleanup releases a native listener registered after unmount', async () => {
  let resolve!: (stop: () => void) => void;
  let stopped = 0;
  const cleanup = subscribeBackendUnavailable(() => assert.fail('Unmounted subscription fired'), {
    native: () => true,
    listen: () => new Promise((done) => { resolve = done; }),
  });
  cleanup();
  resolve(() => { stopped++; });
  await Promise.resolve();
  assert.equal(stopped, 1);
});

test('browser development never registers native events', () => {
  const cleanup = subscribeBackendUnavailable(() => assert.fail(), {
    native: () => false,
    listen: () => { throw new Error('Native API must not run'); },
  });
  cleanup();
});

test('native registration failure reports unavailable without an unhandled rejection', async () => {
  const messages: string[] = [];
  const cleanup = subscribeBackendUnavailable((message) => messages.push(message), {
    native: () => true,
    listen: async () => { throw new Error('IPC unavailable'); },
  });
  await Promise.resolve(); await Promise.resolve();
  assert.match(messages[0], /desktop connection could not be initialized/i);
  cleanup();
});
