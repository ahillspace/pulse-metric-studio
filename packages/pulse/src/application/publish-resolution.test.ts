import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import Fastify from 'fastify';
import { clearSession, closeDb, config, setSession, type TableauSession } from '@pulse-metric-studio/core';
import { defaultPulseMetric, emptyPulseDocument, type DatasourceCatalog } from '@pulse-metric-studio/shared';
import { resolveDefaultMetricId } from '../pulse/pulse-client.js';
import { registerPulseRoutes } from '../pulse/routes.js';

const originalFetch = globalThis.fetch;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-publish-resolution-'));
config.dataDir = directory;
config.dbPath = path.join(directory, 'test.db');
const session: TableauSession = { serverUrl: 'https://fixture.example.test', siteContentUrl: '', siteId: 'site', userId: 'publisher', token: 'fixture-token', apiVersion: '3.27' };
beforeEach(() => setSession(session, { connectionId: 'connection', patSecret: '' }));
afterEach(() => { globalThis.fetch = originalFetch; clearSession(); });
after(() => { closeDb(); fs.rmSync(directory, { recursive: true, force: true }); });

for (const mode of ['permission', 'malformed', 'transient', 'empty', 'creation-stream-failure'] as const) {
  test(`publication durably distinguishes ${mode} default-metric reads without replaying creation`, async () => {
    const datasourceLuid = crypto.randomUUID();
    const field = (id: string, role: 'MEASURE' | 'DIMENSION', dataType: string) => ({ id, name: id, caption: id, label: id, role, dataType, table: null, defaultAggregation: null, formula: null, requiresUserAgg: false });
    const catalog: DatasourceCatalog = { datasourceLuid, datasourceName: 'Fixture', measures: [field('Sales', 'MEASURE', 'REAL')], dimensions: [field('Region', 'DIMENSION', 'STRING')], timeDimensions: [{ ...field('Date', 'DIMENSION', 'DATE'), timeType: 'DATE' }], excluded: [], parameters: [], source: 'vds', warnings: [] };
    const calls = { create: 0, read: 0, subscribe: 0 };
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (init?.method === 'POST' && url.endsWith('/definitions')) {
        calls.create++;
        if (mode === 'creation-stream-failure') return new Response(new ReadableStream({ start(controller) { controller.error(Error('creation response disconnected')); } }));
        return Response.json({ definition: { metadata: { id: 'created-definition' } } });
      }
      if (init?.method === 'POST') { calls.subscribe++; throw Error('Unresolved metrics must not be followed'); }
      calls.read++;
      if (mode === 'permission') return Response.json({ error: { code: '403004', summary: 'Permission denied', detail: 'The current credential cannot read this metric.' } }, { status: 403 });
      if (mode === 'transient') return Response.json({ error: { code: '503000', summary: 'Service unavailable', detail: 'The metric service is temporarily unavailable.' } }, { status: 503 });
      return Response.json(mode === 'empty' ? { metrics: [] } : { unexpected: [] });
    };
    const app = Fastify();
    registerPulseRoutes(app, { catalog: async () => catalog, publish: { resolve: (owner, id) => resolveDefaultMetricId(owner, id, 1) } });
    try {
      const document = { ...emptyPulseDocument(), followMode: 'self' as const };
      document.metrics.Sales = defaultPulseMetric(catalog, 'Sales')!;
      document.slicers.Region = { active: true, fieldId: 'Region', fieldLabel: 'Region' };
      const created = await app.inject({ method: 'POST', url: '/api/pulse/drafts', payload: { context: { connectionId: 'connection', serverUrl: session.serverUrl, siteId: session.siteId, datasourceLuid }, datasourceName: 'Fixture', document } });
      assert.equal(created.statusCode, 200, created.body);
      const draft = created.json();
      const preview = await app.inject({ method: 'POST', url: `/api/pulse/drafts/${draft.id}/publish-preview`, payload: { expectedRevision: draft.revision } });
      assert.equal(preview.statusCode, 200, preview.body);
      const request = { commandId: crypto.randomUUID(), expectedRevision: draft.revision, previewFingerprint: preview.json().previewFingerprint };
      const publish = () => app.inject({ method: 'POST', url: `/api/pulse/drafts/${draft.id}/publish`, payload: request });
      const response = await publish();
      assert.equal(response.statusCode, 200, response.body);
      const receipt = response.json();
      const unknownCreation = mode === 'creation-stream-failure';
      assert.equal(receipt.items[0].creationStatus, unknownCreation ? 'unknown' : 'created');
      assert.equal(receipt.items[0].definitionId, unknownCreation ? null : 'created-definition');
      assert.equal(receipt.items[0].resolutionStatus, unknownCreation ? null : mode === 'empty' ? 'pending' : 'failed');
      assert.equal(receipt.follow.subscriptions[0].status, unknownCreation ? 'not_attempted' : 'skipped');
      if (mode === 'empty') assert.equal(receipt.items[0].diagnostic, null);
      else {
        assert.ok(receipt.items[0].diagnostic?.message);
        if (mode !== 'malformed') assert.equal(receipt.items[0].diagnostic.status, mode === 'permission' ? 403 : unknownCreation ? 0 : 503);
        if (!unknownCreation) assert.notEqual(receipt.follow.subscriptions[0].error, 'No confirmed default metric is available.');
      }
      const stored = await app.inject(`/api/pulse/receipts/${receipt.id}`);
      assert.deepEqual(stored.json().items, receipt.items);
      const replay = await publish();
      assert.equal(replay.json().items[0].resolutionStatus, receipt.items[0].resolutionStatus);
      assert.deepEqual(calls, { create: 1, read: unknownCreation ? 0 : 1, subscribe: 0 });
    } finally { await app.close(); }
  });
}
