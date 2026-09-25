import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PULSE_DIMENSIONAL_FORK_VALUE_MODE_THRESHOLD,
  applyDomainToggle,
  chooseValueMode,
  domainToggleState,
  filterDimensionValues,
  mergeDimensionValues,
  selectedProviderValues,
  type PulseDimensionValue,
} from './dimensional-filter.js';
import { decodeDimensionalForkResponse } from './dimensional-fork-api.js';

const values: PulseDimensionValue[] = [
  { key: 'west', label: 'West', value: 'West' },
  { key: 'central', label: 'Central', value: 'Central' },
];

test('choose value mode branches on the distinct-member count at the threshold boundary', () => {
  assert.equal(PULSE_DIMENSIONAL_FORK_VALUE_MODE_THRESHOLD, 1250);
  assert.equal(chooseValueMode(0), 'fetch-all');
  assert.equal(chooseValueMode(1_250), 'fetch-all');
  assert.equal(chooseValueMode(1_251), 'search-required');
  assert.equal(chooseValueMode(10, 5), 'search-required');
  assert.equal(chooseValueMode(5, 5), 'fetch-all');
});

test('fetch-all select all selects the whole domain and deselect all clears it', () => {
  const select = domainToggleState(values, new Set(), { mode: 'fetch-all', truncated: false });
  assert.deepEqual(select, { action: 'select', disabled: false });
  const selected = applyDomainToggle(select, values, new Set());
  assert.deepEqual([...selected], ['west', 'central']);

  const deselect = domainToggleState(values, selected, { mode: 'fetch-all', truncated: false });
  assert.deepEqual(deselect, { action: 'deselect', disabled: false });
  assert.deepEqual([...applyDomainToggle(deselect, values, selected)], []);
});

test('fetch-all select all is disabled for truncated and empty domains', () => {
  assert.equal(domainToggleState(values, new Set(), { mode: 'fetch-all', truncated: true }).disabled, true);
  assert.match(
    domainToggleState([], new Set(), { mode: 'fetch-all', truncated: false }).reason ?? '',
    /No values are available/,
  );
});

test('search-required select all is scoped to the current complete match set', () => {
  // A complete, within-limit match set: "select all matches" is enabled and
  // selects exactly the visible matches.
  const select = domainToggleState(values, new Set(), { mode: 'search-required', truncated: false });
  assert.deepEqual(select, { action: 'select', disabled: false });
  assert.deepEqual([...applyDomainToggle(select, values, new Set())], ['west', 'central']);

  // A capped (truncated) match set cannot be fully selected: more matches exist
  // than are shown, so the action is disabled with an explanatory reason.
  const capped = domainToggleState(values, new Set(), { mode: 'search-required', truncated: true });
  assert.equal(capped.disabled, true);
  assert.match(capped.reason ?? '', /more matches exist/i);

  // No matches yet: nothing to select.
  assert.equal(domainToggleState([], new Set(), { mode: 'search-required', truncated: false }).disabled, true);
});

test('page merging preserves prior selections and provider values', () => {
  const next = { key: 'east', label: 'East', value: 'East' };
  const duplicate = { key: 'west', label: 'WEST duplicate', value: 'WEST duplicate' };
  const known = mergeDimensionValues(values, [duplicate, next]);
  assert.deepEqual(known, [...values, next]);
  assert.deepEqual(selectedProviderValues(known, new Set(['west', 'east'])), ['West', 'East']);
});

test('search changes visible values without changing the complete domain', () => {
  assert.deepEqual(filterDimensionValues(values, 'cen'), [values[1]]);
  assert.equal(values.length, 2);
});

test('total fork failures retain the structured summary and concise error', () => {
  const body = {
    error: 'Tableau failed every dimensional fork request.',
    attempted: 1,
    created: 0,
    existing: 0,
    failed: 1,
    results: [{
      sourceMetricId: 'metric-1',
      fieldId: 'Region',
      valueFingerprint: 'fingerprint',
      status: 'failed' as const,
      error: 'Provider unavailable.',
    }],
  };
  const outcome = decodeDimensionalForkResponse({ ok: false, status: 502 }, body);
  assert.equal(outcome.error, body.error);
  assert.strictEqual(outcome.summary, body);
  assert.equal(outcome.summary.results[0]?.error, 'Provider unavailable.');

  const incompatible = decodeDimensionalForkResponse(
    { ok: false, status: 422 },
    { ...body, error: 'Every source metric is incompatible with this dimensional fork.' },
  );
  assert.equal(incompatible.error, 'Every source metric is incompatible with this dimensional fork.');
  assert.equal(incompatible.summary.failed, 1);
});

test('successful and mixed fork summaries do not add a top-level error', () => {
  const summary = { attempted: 2, created: 1, existing: 0, failed: 1, results: [] };
  assert.equal(decodeDimensionalForkResponse({ ok: true, status: 207 }, summary).error, undefined);
  assert.equal(decodeDimensionalForkResponse({ ok: true, status: 200 }, summary).error, undefined);
});
