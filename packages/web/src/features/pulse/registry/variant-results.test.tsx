import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PulseVariantResultSchema, type PulseVariantResult } from '@pulse-metric-studio/shared';
import { forkRegistryActionCounts, forkRegistryActionItem, registryActionLabel } from '../registry-actions';
import { RegistryResultsModal } from './views';

function renderResults(results: PulseVariantResult[]) {
  const items = results.map((result, index) => forkRegistryActionItem(result, `Sales source ${index}`, index));
  return {
    items,
    html: renderToStaticMarkup(<RegistryResultsModal results={{ kind: 'fork', title: 'Variant results', finishedAt: 1, items }} onDismiss={() => {}} />),
  };
}

test('variant results separate creation outcomes from overlapping visibility failures', () => {
  const results: PulseVariantResult[] = Array.from({ length: 20 }, (_, index) => ({
    sourceMetricId: `source-${index}`,
    status: index < 4 ? 'visible' : 'failed',
    creationStatus: index < 5 ? 'created' : index < 10 ? 'existing' : 'unknown',
    ...(index < 10 ? { metricId: `destination-${index}`, reconciliationStatus: index < 4 ? 'visible' as const : 'failed' as const } : {}),
    requestedSpecification: {},
  }));
  const { html } = renderResults(results);
  const headline = html.slice(0, html.indexOf('<details'));
  assert.match(headline, /Creation: 5 created, 5 already existed, 10 outcome unknown\./);
  assert.match(headline, /Visibility: 4 verified, 6 failed\./);
  assert.doesNotMatch(headline, /5 created, 5 already existed, 6 failed, 10 outcome unknown/);
});

test('shared destinations retain source mappings without claiming they already existed or multiplying verification failures', () => {
  const primary: PulseVariantResult = { sourceMetricId: 'source-a', metricId: 'destination', status: 'failed', creationStatus: 'created', reconciliationStatus: 'failed', requestedSpecification: {} };
  const alias = PulseVariantResultSchema.parse({ ...primary, sourceMetricId: 'source-b', creationStatus: 'existing', sharedWithSourceMetricId: 'source-a' });
  assert.equal(alias.sharedWithSourceMetricId, 'source-a');
  const { html, items } = renderResults([primary, alias]);
  const counts = forkRegistryActionCounts(items);
  assert.equal(counts.created, 1);
  assert.equal(counts.existing, 0);
  assert.equal(counts.shared, 1);
  assert.equal(counts.failed, 1);
  assert.match(html, /1 additional selected source shares these destinations\./);
  assert.match(html, /shared destination with Sales source 0; visibility verification failed/);
  assert.match(registryActionLabel('fork', items[1]!), /shared destination with source-a; visibility verification failed/);
  assert.doesNotMatch(registryActionLabel('fork', items[1]!), /already exists/);
});

test('known creation rejection is distinct from unknown outcome and visibility failure, including no-ID aliases', () => {
  const primary = PulseVariantResultSchema.parse({ sourceMetricId: 'source-a', status: 'failed', creationStatus: 'failed', requestedSpecification: {} });
  const alias = PulseVariantResultSchema.parse({ ...primary, sourceMetricId: 'source-b', sharedWithSourceMetricId: 'source-a' });
  const { html, items } = renderResults([primary, alias]);
  const counts = forkRegistryActionCounts(items);
  assert.equal(counts.creationFailed, 1);
  assert.equal(counts.unknown, 0);
  assert.equal(counts.failed, 0);
  assert.equal(counts.shared, 1);
  assert.match(html, /Creation: 0 created, 1 failed\./);
  assert.doesNotMatch(html, /Visibility:.*failed/);
  assert.equal(registryActionLabel('fork', items[0]!), 'creation rejected');
});

test('older variant results without alias or explicit creation status retain their fallback meaning', () => {
  const created = forkRegistryActionItem({ sourceMetricId: 'source', status: 'created', metricId: 'destination', requestedSpecification: {} }, 'Sales', 0);
  const rejected = forkRegistryActionItem({ sourceMetricId: 'rejected', status: 'failed', requestedSpecification: {} }, 'Profit', 1);
  const counts = forkRegistryActionCounts([created, rejected]);
  assert.equal(counts.created, 1);
  assert.equal(counts.creationFailed, 1);
  assert.equal(counts.shared, 0);
  assert.equal(registryActionLabel('fork', rejected), 'creation failed');
});


test('authoritative create and existing results need no listing visibility status', () => {
  const { html, items } = renderResults([
    { sourceMetricId: 'source-a', status: 'created', creationStatus: 'created', metricId: 'new', requestedSpecification: {} },
    { sourceMetricId: 'source-b', status: 'existing', creationStatus: 'existing', metricId: 'existing', requestedSpecification: {} },
  ]);
  assert.deepEqual(items.map(item => item.status), ['created', 'existing']);
  assert.match(html, /Creation: 1 created, 1 already existed/);
  assert.doesNotMatch(html, /Visibility:|reconciliation status unavailable|visibility pending/);
  assert.equal(registryActionLabel('fork', items[0]!), 'created');
  assert.equal(registryActionLabel('fork', items[1]!), 'already exists');
});
