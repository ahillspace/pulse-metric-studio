import assert from 'node:assert/strict';
import test from 'node:test';
import type { AuthorResponse, DatasourceCatalog } from '@pulse-metric-studio/shared';
import { api } from './api/client';
import { useStore } from './store';

const source = { luid: 'chat-restore', name: 'Orders', projectName: '' };
const catalog: DatasourceCatalog = { datasourceLuid: source.luid, datasourceName: source.name, measures: [], dimensions: [], timeDimensions: [], parameters: [], excluded: [], source: 'vds', warnings: [] };
const response: AuthorResponse = { ops: [], assistantMessage: 'Updated metrics', provider: 'test', model: 'test', warnings: [] };

test('restoring two messages and sending a new exchange allocates unique chat IDs', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(api, 'fields', async () => ({ catalog }));
  t.mock.method(api, 'loadDraft', async () => ({ draft: { version: 1, chat: [{ role: 'user', content: 'Initial request' }, { role: 'assistant', content: 'Initial draft' }] } }));
  t.mock.method(api, 'existingMetrics', async () => ({ definitions: [] }));
  t.mock.method(api, 'runs', async () => ({ runs: [] }));
  t.mock.method(api, 'author', async () => response);
  useStore.setState({ ...useStore.getInitialState(), datasources: [source] });
  await useStore.getState().selectDatasource(source.luid);
  await useStore.getState().sendChat('Refine the draft');
  const messages = useStore.getState().chat;
  assert.equal(messages.length, 4);
  assert.equal(new Set(messages.map((message) => message.id)).size, 4);
  assert.deepEqual(messages.map((message) => message.content), ['Initial request', 'Initial draft', 'Refine the draft', 'Updated metrics']);
});

test('successful initial draft exposes refinements while failed initial draft stays retryable', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let failed = true;
  t.mock.method(api, 'author', async () => { if (failed) throw new Error('Provider unavailable'); return response; });
  useStore.setState({ ...useStore.getInitialState(), selectedDs: source, catalog });
  await useStore.getState().sendChat('Generate draft', { isDraft: true });
  assert.equal(useStore.getState().hasGeneratedDraft, false);
  assert.equal(useStore.getState().chatBusy, false);
  failed = false;
  await useStore.getState().sendChat('Generate draft', { isDraft: true });
  assert.equal(useStore.getState().hasGeneratedDraft, true);
});
