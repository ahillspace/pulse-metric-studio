import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, test } from 'node:test';
import type { TableauSession } from '@pulse-metric-studio/core';
import type { PulseManageDependencies } from './manage-service.js';

const temporaryDataDir = mkdtempSync(join(tmpdir(), 'pulse-metric-studio-pulse-create-test-'));
const previousDataDir = process.env.PULSE_METRIC_STUDIO_DATA_DIR;
process.env.PULSE_METRIC_STUDIO_DATA_DIR = temporaryDataDir;

const { closeDb } = await import('@pulse-metric-studio/core');
const { publishMetrics } = await import('./create-service.js');
const {
  cachedDefinitionInventory,
  clearPulseManageCaches,
} = await import('./manage-service.js');

const originalFetch = globalThis.fetch;
const session: TableauSession = {
  serverUrl: 'https://example.test',
  siteContentUrl: 'site',
  siteId: 'site-id',
  userId: 'user-id',
  token: 'token',
  apiVersion: '3.27',
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearPulseManageCaches();
});

after(() => {
  closeDb();
  if (previousDataDir === undefined) delete process.env.PULSE_METRIC_STUDIO_DATA_DIR;
  else process.env.PULSE_METRIC_STUDIO_DATA_DIR = previousDataDir;
  rmSync(temporaryDataDir, { recursive: true, force: true });
});

test('successful definition publication invalidates the site inventory cache', async () => {
  let inventoryCalls = 0;
  const inventoryDependencies = {
    listDefinitions: async () => {
      inventoryCalls++;
      return { definitions: [], truncated: false };
    },
  } as unknown as PulseManageDependencies;
  await cachedDefinitionInventory(session, inventoryDependencies);

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/api/-/pulse/definitions') && init?.method === 'POST') {
      return Response.json({ definition: { metadata: { id: 'definition-created-1' } } });
    }
    if (url.endsWith('/api/-/pulse/definitions/definition-created-1/metrics')) {
      return Response.json({ metrics: [{ id: 'metric-created-1' }] });
    }
    return Response.json({ error: 'unexpected request' }, { status: 500 });
  };

  const result = await publishMetrics(session, 'connection-1', {
    payloads: [{
      name: 'Captured metric',
      specification: {
        datasource: { id: 'datasource-1' },
        basic_specification: {
          measure: { field: 'Sales' },
          time_dimension: { field: 'Order Date' },
          filters: [],
        },
      },
      extension_options: { allowed_dimensions: [] },
    }],
    withGroupFollow: false,
    datasourceLuid: 'datasource-1',
    datasourceName: 'Orders',
  });
  assert.equal(result.createdCount, 1);

  await cachedDefinitionInventory(session, inventoryDependencies);
  assert.equal(inventoryCalls, 2);
});
