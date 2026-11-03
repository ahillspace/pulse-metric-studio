import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { TableauSession } from '@pulse-metric-studio/core';
import { getExistingMetrics } from './inventory.js';
import { addUserToGroup, deleteGroup } from '../pulse/groups.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const session: TableauSession = { serverUrl: 'https://fixture.example.test', siteContentUrl: '', siteId: 'site', userId: 'inventory-streams', token: 'fixture-token', apiVersion: '3.27' };
const specification = { filters: [], measurement_period: { granularity: 'GRANULARITY_BY_MONTH', range: 'RANGE_CURRENT_PARTIAL' } };

test('normal inventory expansion cannot open more than eight exact-metric response bodies', async () => {
  const definitions = Array.from({ length: 5 }, (_, i) => ({ metadata: { id: `d${i}`, name: `Definition ${i}` }, specification: { datasource: { id: 'ds' }, basic_specification: { measure: { field: 'Sales', aggregation: 'AGGREGATION_SUM' }, time_dimension: { field: 'Date' } } } }));
  const bodies: Array<{ id: string; controller: ReadableStreamDefaultController<Uint8Array> }> = [];
  let released = false;
  let metricReads = 0;
  const exact = (id: string) => ({ metric: { id, definition_id: id.split('m')[0], is_default: false, specification } });
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === '/api/-/pulse/definitions') return Response.json({ definitions });
    const definition = /\/definitions\/(d\d+)\/metrics$/.exec(path);
    if (definition) return Response.json({ metrics: Array.from({ length: 5 }, (_, i) => ({ id: `${definition[1]}m${i}` })) });
    const metric = /\/metrics\/(d\d+m\d+)$/.exec(path);
    assert.ok(metric, path);
    metricReads++;
    if (released) return Response.json(exact(metric[1]));
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { bodies.push({ id: metric[1], controller }); } }));
  };
  const loading = getExistingMetrics(session, 'ds');
  for (let i = 0; i < 200 && bodies.length < 8; i++) await new Promise((resolve) => setTimeout(resolve, 2));
  try {
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(bodies.length, 8, 'the real nested inventory expansion keeps the transport body limit');
  } finally {
    released = true;
    for (const { id, controller } of bodies) { controller.enqueue(new TextEncoder().encode(JSON.stringify(exact(id)))); controller.close(); }
  }
  const inventory = await loading;
  assert.equal(metricReads, 25);
  assert.equal(inventory.definitions.length, 5);
  assert.equal(inventory.definitions.reduce((count, definition) => count + definition.metrics.length, 0), 25);
  assert.deepEqual(inventory.failures, []);
});

for (const operation of ['membership', 'group-delete'] as const) {
  test(`confirmed ${operation} does not depend on an irrelevant broken body`, async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response(new ReadableStream({ start(controller) { controller.error(Error('body reset')); } }), { status: operation === 'membership' ? 409 : 200 });
    };
    if (operation === 'membership') await addUserToGroup(session, 'group', 'user');
    else await deleteGroup(session, 'group');
    assert.equal(calls, 1);
  });
}
