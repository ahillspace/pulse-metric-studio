import assert from 'node:assert/strict';
import { test } from 'node:test';
import { previewCardInput, previewInsightInput, previewPngDataUrl } from './metric-preview.js';

const definition: any = { metadata: { id: 'definition', name: 'Revenue' }, specification: { datasource: { id: 'source' } }, extension_options: {}, representation_options: {}, insights_options: {} };
const metric: any = { id: 'metric', specification: { measurement_period: { granularity: 'GRANULARITY_BY_MONTH', range: 'RANGE_CURRENT_PARTIAL' }, filters: [] } };
const popc = { type: 'popc', score: 1, markup: '<span>100</span>', facts: { value: 100 }, viz: { mark: 'line', data: { values: [{ value: 100 }] } } };
const top = { type: 'top-drivers', score: 5, markup: 'Category grew.', facts: { change: 10 } };
const bundle = (insights: unknown[], extras = {}) => ({ bundle_response: { result: { insight_groups: [{ insights: insights.map(result => ({ result })) }], ...extras } } });
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test('preview uses exact provider metadata and preserves chart, markup, and facts', () => {
  const input = previewInsightInput(definition, metric, 'metric', 'definition');
  assert.deepEqual(input.bundle_request.input.metric.definition, definition.specification);
  assert.deepEqual(input.bundle_request.input.metric.metric_specification, metric.specification);
  const card = previewCardInput(definition, metric, bundle([popc, { ...top, score: 1, markup: 'Lower-ranked' }, top]));
  assert.deepEqual(card.input.viz, popc.viz);
  assert.deepEqual(card.input.insights.popc, { markup: popc.markup, facts: popc.facts });
  assert.deepEqual(card.input.insights.top, { markup: top.markup, facts: top.facts });
  assert.deepEqual(card.input.metricMetadata.measurementPeriod, metric.specification.measurement_period);
  assert.deepEqual(card.input.metricMetadata.filters, []);
});

test('unrelated partial errors do not prevent a complete preview', () => {
  const response = bundle([popc, top], { has_errors: true });
  response.bundle_response.result.insight_groups.push({ error: { code: 'unrelated' } } as any);
  assert.equal(previewCardInput(definition, metric, response).input.insights.top.markup, top.markup);
});

test('missing, ambiguous, skipped, and failed required insights produce unavailable', () => {
  for (const response of [
    { bundle_response: { error: { code: 'failed' } } },
    bundle([]), bundle([top]), bundle([popc]), bundle([popc, popc, top]),
    bundle([{ ...popc, score: -1 }, top]),
    { bundle_response: { result: { insight_groups: [{ error: { code: 'group-failed' }, insights: [{ result: popc }, { result: top }] }] } } },
    { bundle_response: { result: { insight_groups: [{ insights: [{ error: { code: 'failed' }, result: popc }, { result: top }] }] } } },
    { bundle_response: { result: { insight_groups: [{ insights: [{ skip_details: { reason: 'no_data' }, result: popc }, { result: top }] }] } } },
  ]) assert.throws(() => previewCardInput(definition, metric, response), (error: any) => error.code === 'pulse_preview_unavailable');
});

test('missing metric metadata does not manufacture a preview definition', () => {
  assert.throws(() => previewInsightInput(definition, { id: 'metric' }, 'metric', 'definition'), /metadata/);
});

test('preview validates PNG data, decoded size, and dimensions', () => {
  assert.equal(previewPngDataUrl({ content: png }), `data:image/png;base64,${png}`);
  for (const content of ['', 'not a png', Buffer.from('<svg />').toString('base64'), png + 'abcd'])
    assert.throws(() => previewPngDataUrl({ content }), (error: any) => error.code === 'pulse_preview_invalid_response');
  assert.throws(() => previewPngDataUrl({ content: 'A'.repeat(6 * 1024 * 1024) }), (error: any) => error.code === 'pulse_preview_too_large');
  const huge = Buffer.from(png, 'base64');
  huge.writeUInt32BE(100000, 16);
  assert.throws(() => previewPngDataUrl({ content: huge.toString('base64') }), (error: any) => error.code === 'pulse_preview_too_large');
});


test('preview rejects missing image data, corrupted CRCs, duplicate headers, and unsupported interlace', () => {
  const valid = Buffer.from(png, 'base64');
  const headerOnly = Buffer.concat([valid.subarray(0, 33), valid.subarray(valid.length - 12)]);
  const corrupt = Buffer.from(valid); corrupt[45] = corrupt[45]! ^ 1;
  const duplicateHeader = Buffer.concat([valid.subarray(0, 33), valid.subarray(8)]);
  for (const [name, invalid] of Object.entries({ headerOnly, corruptCrc: corrupt, duplicateHeader, truncated: valid.subarray(0, valid.length - 3) }))
    assert.throws(() => previewPngDataUrl({ content: invalid.toString('base64') }), (error: any) => error.code === 'pulse_preview_invalid_response', name);
  const interlaced = Buffer.from(valid); interlaced[28] = 1;
  assert.throws(() => previewPngDataUrl({ content: interlaced.toString('base64') }), (error: any) => error.code === 'pulse_preview_unavailable' && /interlaced/.test(error.message));
});
