import assert from 'node:assert/strict';
import test from 'node:test';
import type { BuilderDraft } from '@pulse-metric-studio/shared';
import { createDraftSaveQueue, type DraftSaveState, type DraftSnapshot } from './draft-save-queue';
const snapshot = (key: string, name: string): DraftSnapshot => ({ key, context: { connectionId: key, serverUrl: `https://${key}.example`, siteId: 'site' }, draft: { version: 1, datasourceLuid: key, datasourceName: name, metrics: {}, slicers: {}, chat: [], updatedAt: 1, digestAudience: '', digestAudienceLocked: false, groupFollow: false } satisfies BuilderDraft });

test('per-key writer serializes revisions and keeps independent datasource saves', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls: DraftSnapshot[] = [];
  let finish!: () => void;
  const queue = createDraftSaveQueue(async (value) => { calls.push(value); if (calls.length === 1) await new Promise<void>((done) => { finish = done; }); }, () => {});
  queue.schedule(snapshot('a', 'First A'));
  t.mock.timers.tick(600);
  assert.equal(calls.length, 1);
  queue.schedule(snapshot('a', 'Final A'));
  queue.schedule(snapshot('b', 'B'));
  t.mock.timers.tick(600);
  assert.deepEqual(calls.map((call) => call.draft.datasourceName), ['First A', 'B']);
  finish();
  await queue.retry();
  assert.deepEqual(calls.map((call) => call.draft.datasourceName), ['First A', 'B', 'Final A']);
  assert.equal(queue.pending('a'), undefined);
});

test('failed save retains exact pending draft and context for restoration and retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const states: DraftSaveState[] = [];
  const calls: DraftSnapshot[] = [];
  let failed = true;
  const queue = createDraftSaveQueue(async (value) => { calls.push(value); if (failed) throw new Error('Disk full'); }, (state) => states.push(state));
  const pending = snapshot('a', 'A final edit');
  queue.schedule(pending);
  await queue.flush('a');
  assert.equal(states.at(-1)?.status, 'error');
  assert.equal(states.at(-1)?.error, 'Disk full');
  assert.deepEqual(queue.pending('a'), pending.draft);
  failed = false;
  await queue.retry();
  assert.equal(states.at(-1)?.status, 'saved');
  assert.deepEqual(calls, [pending, pending]);
});
