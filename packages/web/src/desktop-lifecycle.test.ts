import assert from 'node:assert/strict';
import test from 'node:test';
import { subscribeDesktopLifecycle } from './desktop-lifecycle';

function fixture() {
  const handlers = new Map<string, (payload: { message?: string }) => void>();
  const actions: string[] = [];
  const messages: string[] = [];
  const errors: unknown[] = [];
  const browser = new EventTarget();
  let stopped = 0;
  let cancelled = 0;
  const callbacks = {
    onUnavailable: (message: string) => { messages.push(message); },
    prepareClose: async () => {},
    cancelClose: () => { cancelled++; },
    onCloseError: (error: unknown) => { errors.push(error); },
    hasUnsavedChanges: () => false,
  };
  const events = {
    native: () => true,
    listen: async (event: 'pulse-backend-unavailable' | 'pulse-shutdown-requested', handler: (payload: { message?: string }) => void) => {
      handlers.set(event, handler);
      return () => { stopped++; };
    },
    shutdown: async (action: 'ready' | 'complete' | 'cancel') => { actions.push(action); },
  };
  return { callbacks, events, browser, handlers, actions, messages, errors, stopped: () => stopped, cancelled: () => cancelled };
}

test('native backend events reach the shell and stop after cleanup', async () => {
  const f = fixture();
  const cleanup = subscribeDesktopLifecycle(f.callbacks, f.events, f.browser);
  await Promise.resolve();
  f.handlers.get('pulse-backend-unavailable')!({ message: 'Service exited' });
  assert.deepEqual(f.messages, ['Service exited']);
  cleanup(); cleanup();
  f.handlers.get('pulse-backend-unavailable')!({ message: 'Late event' });
  assert.equal(f.stopped(), 2);
  assert.equal(f.messages.length, 1);
});

test('window close and tray quit requests wait for persistence and share one pending close', async () => {
  const f = fixture();
  let saved!: () => void;
  let requests = 0;
  f.callbacks.prepareClose = () => {
    requests++;
    return new Promise((resolve) => { saved = resolve; });
  };
  const cleanup = subscribeDesktopLifecycle(f.callbacks, f.events, f.browser);
  await Promise.resolve();
  assert.deepEqual(f.actions, ['ready']);
  f.handlers.get('pulse-shutdown-requested')!({});
  f.handlers.get('pulse-shutdown-requested')!({});
  assert.equal(requests, 1);
  assert.deepEqual(f.actions, ['ready']);

  saved();
  await Promise.resolve();
  assert.deepEqual(f.actions, ['ready', 'complete']);
  await Promise.resolve();
  cleanup();
});

test('failed persistence keeps the app open and permits another close request', async () => {
  const f = fixture();
  f.callbacks.prepareClose = async () => { throw new Error('Disk full'); };
  const cleanup = subscribeDesktopLifecycle(f.callbacks, f.events, f.browser);
  await Promise.resolve();
  f.handlers.get('pulse-shutdown-requested')!({});
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(f.actions, ['ready']);
  assert.equal(f.cancelled(), 1);
  assert.match(String(f.errors[0]), /Disk full/);

  f.callbacks.prepareClose = async () => {};
  f.handlers.get('pulse-shutdown-requested')!({});
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(f.actions, ['ready', 'complete']);
  cleanup();
});

test('cleanup cancels an old close attempt without approving it after remount', async () => {
  const f = fixture();
  let saved!: () => void;
  f.callbacks.prepareClose = () => new Promise((resolve) => { saved = resolve; });
  const cleanup = subscribeDesktopLifecycle(f.callbacks, f.events, f.browser);
  await Promise.resolve();
  f.handlers.get('pulse-shutdown-requested')!({});
  cleanup();
  assert.equal(f.cancelled(), 1);
  saved();
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(f.actions, ['ready']);
});

test('cancelled persistence releases the native request without completing shutdown', async () => {
  const f = fixture();
  f.callbacks.prepareClose = async () => { throw new DOMException('Closing cancelled.', 'AbortError'); };
  const cleanup = subscribeDesktopLifecycle(f.callbacks, f.events, f.browser);
  await Promise.resolve();
  f.handlers.get('pulse-shutdown-requested')!({});
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(f.actions, ['ready', 'cancel']);
  cleanup();
});

test('StrictMode cleanup releases both listeners registered after unmount', async () => {
  const f = fixture();
  const registrations: Array<() => void> = [];
  f.events.listen = () => new Promise((resolve) => {
    registrations.push(() => resolve(() => { f.actions.push('unlisten'); }));
  });
  const cleanup = subscribeDesktopLifecycle(f.callbacks, f.events, f.browser);
  cleanup();
  for (const register of registrations) register();
  await Promise.resolve();
  assert.deepEqual(f.actions, ['unlisten', 'unlisten']);
});

test('browser navigation warns only while work is unsaved and never uses native IPC', () => {
  const f = fixture();
  f.events.native = () => false;
  f.events.listen = async () => { throw new Error('Native API must not run'); };
  const cleanup = subscribeDesktopLifecycle(f.callbacks, f.events, f.browser);
  const saved = new Event('beforeunload', { cancelable: true });
  f.browser.dispatchEvent(saved);
  assert.equal(saved.defaultPrevented, false);

  f.callbacks.hasUnsavedChanges = () => true;
  const unsaved = new Event('beforeunload', { cancelable: true });
  Object.defineProperty(unsaved, 'returnValue', { value: undefined, writable: true });
  f.browser.dispatchEvent(unsaved);
  assert.equal(unsaved.defaultPrevented, true);
  cleanup();
  const disposed = new Event('beforeunload', { cancelable: true });
  f.browser.dispatchEvent(disposed);
  assert.equal(disposed.defaultPrevented, false);
  assert.deepEqual(f.actions, []);
});

test('native registration failure reports unavailable without an unhandled rejection', async () => {
  const f = fixture();
  f.events.listen = async () => { throw new Error('IPC unavailable'); };
  const cleanup = subscribeDesktopLifecycle(f.callbacks, f.events, f.browser);
  await Promise.resolve(); await Promise.resolve();
  assert.match(f.messages[0], /desktop connection could not be initialized/i);
  cleanup();
});
