import assert from 'node:assert/strict';
import test from 'node:test';
import type { DatasourceCatalog, MetricSelection } from '@pulse-metric-studio/shared';
import type { FollowState } from './registry/view-types.js';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { applyDigestAudienceUpdate } from './digest-audience.js';
import { emptyTimeDimensionDiagnostic, metricHasEligibleTimeDimension } from './field-readiness.js';
import {
  buildFollowTargetOperations,
  currentUserFollowTarget,
  followTargetMatchesQuery,
  handleFollowTargetSelectionKey,
  reconcileFollowTargetResults,
  resolveCurrentUserFollowTarget,
  targetLabelKey,
  type FollowTargetChoice,
} from './follow-target-actions.js';
import { followStateLabel, mergeFollowStates, metricIsFollowed, unavailableFollowState } from './follow-state.js';
import {
  canonicalPlanPreview,
  dimensionClauseSummary,
  measurementPeriodSignature,
  reconcileMetricSelection,
  selectionState,
  setMetricSelection,
  timeframeFamilyMetricIds,
  timeframeScopeFamilies,
  timeframeScopeSignature,
  upsertDimensionClause,
  type PulseRegistryMetric,
} from './fork-plan.js';
import {
  forkRegistryActionCounts,
  forkRegistryActionItem,
  registryActionCounts,
  registryActionLabel,
  registryActionOutcome,
  registryTargetHeadline,
  summarizeRegistryTargets,
  type RegistryActionItem,
} from './registry-actions.js';
import { decodeVariantResponse } from './api/registry.js';
import { validatePulseDocument, emptyPulseDocument } from '@pulse-metric-studio/shared';
import {
  consumeFollowTargetSearchEscape,
  FollowTargetModal,
} from './components/FollowTargetModal.js';
import {
  countDistinctFollowers,
  deletionBlastRadius,
  followerDetailLines,
  forkFriendlyName,
  previewSourceLabel,
  summarizeFollowerRelationships,
} from './components/ExistingMetrics.js';

const metrics: PulseRegistryMetric[] = [
  {
    metricId: 'm-1',
    definitionId: 'd-1',
    name: 'Sales current',
    timeframeLabel: 'Month to date',
    measurementPeriod: { range: 'RANGE_CURRENT_PARTIAL', granularity: 'GRANULARITY_BY_MONTH' },
    filters: [{ field: 'Channel' }],
  },
  {
    metricId: 'm-2',
    definitionId: 'd-1',
    name: 'Sales rolling',
    timeframeLabel: 'Last 30 days',
    measurementPeriod: { range: 'RANGE_BY_CONFIG', granularity: 'GRANULARITY_BY_DAY', last_x_period: { period: 30 } },
  },
  {
    metricId: 'm-3',
    definitionId: 'd-2',
    name: 'Profit rolling',
    timeframeLabel: 'Last 30 days',
    measurementPeriod: { last_x_period: { period: 30 }, granularity: 'GRANULARITY_BY_DAY', range: 'RANGE_BY_CONFIG' },
  },
];

test('exact metric selection synchronizes parents, the registry, and inventory refreshes', () => {
  let selected = setMetricSelection([], ['m-2', 'm-1'], true);
  assert.deepEqual(selected, ['m-1', 'm-2']);
  assert.deepEqual(selectionState(new Set(selected), ['m-1', 'm-2']), {
    checked: true,
    indeterminate: false,
    selected: 2,
    total: 2,
  });
  selected = setMetricSelection(selected, ['m-1'], false);
  assert.equal(selectionState(new Set(selected), ['m-1', 'm-2']).indeterminate, true);
  assert.deepEqual(reconcileMetricSelection([...selected, 'removed'], ['m-2', 'm-3']), ['m-2']);
});

test('timeframe family selection uses a canonical measurement-period signature', () => {
  assert.equal(measurementPeriodSignature(metrics[1]), measurementPeriodSignature(metrics[2]));
  assert.deepEqual(timeframeFamilyMetricIds(metrics, measurementPeriodSignature(metrics[1])), ['m-2', 'm-3']);
});

test('timeframe-scope family excludes a dimension-forked sibling that shares the timeframe', () => {
  const family: PulseRegistryMetric[] = [
    { metricId: 'def', definitionId: 'd', name: 'Sales', timeframeLabel: 'Last 30 days', measurementPeriod: { last_x_period: { period: 30 } } },
    {
      metricId: 'fork',
      definitionId: 'd',
      name: 'Sales West',
      timeframeLabel: 'Last 30 days',
      measurementPeriod: { last_x_period: { period: 30 } },
      filters: [{ field: 'Region', categorical_values: [{ string_value: 'West' }] }],
    },
    { metricId: 'def2', definitionId: 'd2', name: 'Profit', timeframeLabel: 'Last 30 days', measurementPeriod: { last_x_period: { period: 30 } } },
  ];
  // Clicking the unfiltered default selects unfiltered same-timeframe metrics across definitions - never the fork.
  const families = timeframeScopeFamilies(family);
  assert.deepEqual(families.get(timeframeScopeSignature(family[0])), ['def', 'def2']);
  // Clicking the fork selects only identically-filtered forks (here, just itself).
  assert.deepEqual(families.get(timeframeScopeSignature(family[1])), ['fork']);
});

test('large inventories build timeframe families with bounded signature reads', () => {
  let reads = 0;
  const inventory = Array.from({ length: 2000 }, (_, index) => ({
    metricId: `metric-${index}`, definitionId: `definition-${index}`, name: `Metric ${index}`,
    timeframeLabel: 'Month to date',
    get measurementPeriod() { reads++; return { range: 'CURRENT', granularity: 'MONTH' }; },
    filters: [],
  }));
  const families = timeframeScopeFamilies(inventory);
  assert.equal(families.size, 1);
  assert.equal([...families.values()][0].length, 2000);
  assert.ok(reads >= inventory.length);
  assert.ok(reads <= inventory.length * 3, `Unexpected repeated inventory scans: ${reads} reads`);
  const selected = new Set(['metric-1', 'metric-2']);
  assert.deepEqual(selectionState(selected, [...families.values()][0]), {
    checked: false, indeterminate: true, selected: 2, total: 2000,
  });
});

test('dimension clause summary uses Tableau keeps/exclude language', () => {
  const values = (labels: string[]) => labels.map((label) => ({ key: label, label, value: label }));
  assert.equal(dimensionClauseSummary({ fieldId: 'f', fieldLabel: 'Region', exclude: false, values: values(['East']) }), 'East');
  assert.equal(dimensionClauseSummary({ fieldId: 'f', fieldLabel: 'Region', exclude: false, values: values(['East', 'West']) }), 'keeps 2');
  assert.equal(dimensionClauseSummary({ fieldId: 'f', fieldLabel: 'Cust', exclude: true, values: values(['Aaron']) }), 'excludes Aaron');
  assert.equal(dimensionClauseSummary({ fieldId: 'f', fieldLabel: 'Cust', exclude: true, memberTotal: 800, values: values(['Aaron', 'Beth']) }), 'keeps 798');
  assert.equal(dimensionClauseSummary({ fieldId: 'f', fieldLabel: 'Cust', exclude: true, values: values(['Aaron', 'Beth']) }), 'excludes 2');
});

test('preview source label prefers real names and never leads with a LUID', () => {
  assert.equal(previewSourceLabel('Average Win Rate', 'Def', 'm-1', 'Last 30 days'), 'Average Win Rate - Last 30 days');
  assert.equal(previewSourceLabel('luid-xyz', 'Superstore Sales', 'luid-xyz', 'Month to date'), 'Superstore Sales - Month to date');
});

test('follow results summarize per target and treat already-followed as success', () => {
  const items: RegistryActionItem[] = [
    { key: '1', metricId: 'm1', metricLabel: 'M1', targetId: 'sales', targetKind: 'GROUP', targetLabel: 'Group Sales', status: 'created' },
    { key: '2', metricId: 'm2', metricLabel: 'M2', targetId: 'sales', targetKind: 'GROUP', targetLabel: 'Group Sales', status: 'existing' },
    { key: '3', metricId: 'm3', metricLabel: 'M3', targetId: 'sales', targetKind: 'GROUP', targetLabel: 'Group Sales', status: 'created' },
  ];
  const [summary] = summarizeRegistryTargets(items);
  assert.deepEqual(summary, { targetId: 'sales', targetKind: 'GROUP', targetLabel: 'Group Sales', total: 3, created: 2, existing: 1, removed: 0, notFollowed: 0, failed: 0 });
  assert.equal(registryTargetHeadline('follow', summary), 'Group Sales now follows 3 of 3 metrics (1 already followed)');
  assert.equal(registryActionOutcome(items), 'success');
});

test('follow results surface failures as mixed without hiding successes', () => {
  const items: RegistryActionItem[] = [
    { key: '1', metricId: 'm1', metricLabel: 'M1', targetId: 'sales', targetKind: 'GROUP', targetLabel: 'Group Sales', status: 'created' },
    { key: '2', metricId: 'm2', metricLabel: 'M2', targetId: 'sales', targetKind: 'GROUP', targetLabel: 'Group Sales', status: 'failed' },
  ];
  assert.equal(registryActionOutcome(items), 'mixed');
  assert.equal(registryTargetHeadline('follow', summarizeRegistryTargets(items)[0]), 'Group Sales now follows 1 of 2 metrics (1 failed)');
});

test('same-named users and groups keep separate subscription results and counts', () => {
  const operations = buildFollowTargetOperations(
    [{ id: 'm1' }, { id: 'm2' }],
    [{ id: 'sales', kind: 'USER' }, { id: 'sales', kind: 'GROUP' }],
  );
  const results = operations.map((operation, index) => ({
    metricId: operation.metricId, targetId: operation.target.id, targetKind: operation.target.kind,
    ok: index !== 2, status: index === 2 ? 'failed' as const : 'followed' as const,
  }));
  const reconciled = reconcileFollowTargetResults('follow', operations, results, {
    metricLabels: new Map(),
    targetLabels: new Map([[targetLabelKey('USER', 'sales'), 'Sales'], [targetLabelKey('GROUP', 'sales'), 'Sales']]),
  });
  const summaries = summarizeRegistryTargets(reconciled.items);
  assert.equal(summaries.length, 2);
  assert.deepEqual(summaries.map(summary => registryTargetHeadline('follow', summary)), [
    'User Sales now follows 1 of 2 metrics (1 failed)',
    'Group Sales now follows 2 of 2 metrics',
  ]);
});

test('same-named users retain distinct result identities', () => {
  const summaries = summarizeRegistryTargets(['one', 'two'].map(targetId => ({
    key: targetId, metricId: 'metric', metricLabel: 'Metric', targetId, targetKind: 'USER', targetLabel: 'Sales', status: 'created',
  })));
  assert.deepEqual(summaries.map(summary => summary.targetLabel), ['User Sales (one)', 'User Sales (two)']);
  assert.ok(summaries.every(summary => summary.total === 1));
});

test('dimension clauses replace the same field and canonicalize values', () => {
  const first = upsertDimensionClause([], {
    fieldId: 'region',
    fieldLabel: 'Region',
    exclude: false,
    values: [
      { key: 'west', label: 'West', value: 'West' },
      { key: 'east', label: 'East', value: 'East' },
    ],
  });
  const replaced = upsertDimensionClause(first, {
    fieldId: 'region',
    fieldLabel: 'Region',
    exclude: false,
    values: [
      { key: 'central', label: 'Central', value: 'Central' },
      { key: 'central', label: 'Central', value: 'Central' },
    ],
  });
  assert.equal(replaced.length, 1);
  assert.deepEqual(replaced[0].values.map((entry) => entry.value), ['Central']);
});

test('canonical preview retains each exact source specification and stages one output per source', () => {
  const preview = canonicalPlanPreview(metrics, {
    selectedMetricIds: ['m-2', 'm-1'],
    timeframe: { key: 'LAST_30_DAYS', label: 'Last 30 days' },
    clauses: [{
      fieldId: 'region',
      fieldLabel: 'Region',
      exclude: false,
      values: [{ key: 'west', label: 'West', value: 'West' }],
    }],
  });
  assert.deepEqual(preview.map((entry) => entry.sourceMetricId), ['m-1', 'm-2']);
  assert.deepEqual((preview[0].sourceSpecification as { filters: unknown[] }).filters, [{ field: 'Channel' }]);
  assert.deepEqual(preview[0].requestedChanges.dimensionalClauses, [{ fieldId: 'region', exclude: false, values: ['West'] }]);
});

test('locked digest audience rejects LLM changes but accepts human changes', () => {
  assert.equal(applyDigestAudienceUpdate('Store Ops', 'All employees', true, 'llm'), 'Store Ops');
  assert.equal(applyDigestAudienceUpdate('Store Ops', 'Field leaders', true, 'human'), 'Field leaders');
  assert.equal(applyDigestAudienceUpdate('Store Ops', 'All employees', false, 'llm'), 'All employees');
});

test('publish readiness rejects stale time field IDs and emits count-only diagnostics', () => {
  const catalog = {
    datasourceLuid: 'ds-1',
    datasourceName: 'Orders',
    measures: [{
      id: 'sales', name: 'Sales', caption: 'Sales', label: 'Sales', role: 'MEASURE',
      dataType: 'REAL', table: 'Orders', defaultAggregation: 'SUM', formula: null, requiresUserAgg: false,
    }],
    dimensions: [],
    timeDimensions: [{
      id: 'order-date',
      label: 'Order Date',
      name: 'Order Date',
      caption: 'Order Date',
      role: 'DIMENSION',
      dataType: 'date',
      timeType: 'DATE',
      table: 'Orders',
      defaultAggregation: null,
      formula: null,
      requiresUserAgg: false,
    }],
    parameters: [],
    excluded: [],
    source: 'vds',
    warnings: [],
    diagnostics: {
      counts: { discovered: 20, measures: 4, dimensions: 11, timeDimensions: 0, excluded: 5 },
      excludedByReason: {},
      timeDimensionExcludedByReason: { excluded: 2, measureRole: 1, unsupportedType: 3 },
      suspiciousZeroTimeDimensions: true,
    },
  } as DatasourceCatalog;
  const selection = {
    active: true,
    fieldId: 'sales',
    fieldLabel: 'Sales',
    name: 'Sales',
    description: '',
    temporality: 'OVER_TIME',
    timeDimensionFieldId: 'stale-date',
  } as MetricSelection;
  assert.equal(metricHasEligibleTimeDimension(selection, catalog), false);
  const message = emptyTimeDimensionDiagnostic(catalog);
  assert.match(message, /20 discovered/);
  assert.doesNotMatch(message, /order-date/);
  const errors = validatePulseDocument({ ...emptyPulseDocument(), metrics: { sales: selection } }, catalog);
  assert.ok(errors.some((issue) => issue.field.includes('timeDimension') || issue.message.toLowerCase().includes('time')));
});

test('follow-state batches merge without dropping metrics', () => {
  const merged = mergeFollowStates([
    {
      userFollowsByMetricId: { 'm-1': true },
      groupFollowsByMetricId: {},
      followerCountsByMetricId: { 'm-1': 1 },
      errors: [],
    },
    {
      userFollowsByMetricId: {},
      groupFollowsByMetricId: { 'm-250': true },
      followerCountsByMetricId: { 'm-250': 3 },
      errors: ['partial'],
    },
  ]);
  assert.equal(merged.groupFollowsByMetricId['m-250'], true);
  assert.deepEqual(merged.errors, ['partial']);
  const unavailable = unavailableFollowState(['m-400'], 'request failed');
  assert.equal(unavailable.availabilityByMetricId?.['m-400']?.status, 'unavailable');
  assert.equal(metricIsFollowed(unavailable, 'm-400'), true);
  assert.deepEqual(mergeFollowStates([merged, unavailable]).errors, ['partial', 'm-400: request failed']);
});

test('follow-state labels preserve relationships when counts are unavailable', () => {
  assert.equal(followStateLabel({
    userFollowsByMetricId: { 'm-1': true },
    groupFollowsByMetricId: { 'm-1': false },
    followerCountsByMetricId: {},
    errors: ['m-1: count unavailable'],
    availabilityByMetricId: {
      'm-1': {
        status: 'partial',
        relationshipStatus: 'available',
        followerCountStatus: 'unavailable', diagnostics: [],
      },
    },
  }, 'm-1'), 'You follow - follower count unavailable');
});

test('follow target contracts preserve exact pairs and isolate failed operations for retry', () => {
  const operations = buildFollowTargetOperations(
    [{ id: 'metric-exact-1' }, { id: 'metric-exact-2' }],
    [
      { id: 'target-same-id', kind: 'GROUP' },
      { id: 'target-same-id', kind: 'USER' },
    ],
  );
  assert.equal(operations.length, 4);
  assert.deepEqual(operations[0], {
    metricId: 'metric-exact-1',
    target: { id: 'target-same-id', kind: 'GROUP' },
  });
  const reconciled = reconcileFollowTargetResults('follow', operations, [
    {
      metricId: 'metric-exact-1',
      targetId: 'target-same-id',
      targetKind: 'GROUP',
      status: 'already_followed',
      ok: true,
    },
    {
      metricId: 'metric-exact-1',
      targetId: 'target-same-id',
      targetKind: 'USER',
      status: 'followed',
      ok: true,
    },
    {
      metricId: 'metric-exact-2',
      targetId: 'target-same-id',
      targetKind: 'GROUP',
      status: 'failed',
      ok: false,
      error: 'pair failed',
    },
  ], {
    metricLabels: new Map([['metric-exact-1', 'Metric one'], ['metric-exact-2', 'Metric two']]),
    targetLabels: new Map([
      [targetLabelKey('GROUP', 'target-same-id'), 'Sales group'],
      [targetLabelKey('USER', 'target-same-id'), 'Sales user'],
    ]),
  });
  assert.deepEqual(reconciled.items.map((item) => item.status), ['existing', 'created', 'failed', 'failed']);
  assert.deepEqual(reconciled.retryOperations, [operations[2], operations[3]]);
  assert.equal(reconciled.items[2]?.targetLabel, 'Sales group');
  assert.equal(reconciled.items[3]?.targetLabel, 'Sales user');
});

test('follow target search selects with Enter but never with Space, and exposes multi-select ARIA', () => {
  // Enter selects the active option.
  let prevented = false;
  let selected = '';
  const enterHandled = handleFollowTargetSelectionKey(
    { key: 'Enter', preventDefault: () => { prevented = true; } },
    { id: 'group-exact' },
    (target) => { selected = target.id; },
  );
  assert.equal(enterHandled, true);
  assert.equal(prevented, true);
  assert.equal(selected, 'group-exact');

  // Space must NOT select: the search field is a text input, so a space is
  // typed, not treated as a toggle. This is the "spacebar selects a user while
  // I type" regression guard.
  let spacePrevented = false;
  let spaceSelected = '';
  const spaceHandled = handleFollowTargetSelectionKey(
    { key: ' ', preventDefault: () => { spacePrevented = true; } },
    { id: 'group-exact' },
    (target) => { spaceSelected = target.id; },
  );
  assert.equal(spaceHandled, false);
  assert.equal(spacePrevented, false);
  assert.equal(spaceSelected, '');

  const markup = renderToStaticMarkup(createElement(FollowTargetModal, {
    metrics: [{ id: 'metric-exact', label: 'Exact metric' }],
    currentUserId: 'user-exact',
    onClose: () => undefined,
  }));
  assert.match(markup, /role="combobox"/);
  assert.match(markup, /aria-haspopup="listbox"/);
  assert.match(markup, /role="listbox"/);
  assert.match(markup, /aria-multiselectable="true"/);
});

test('follow target search consumes Escape only when it clears a query', () => {
  let prevented = false;
  let stopped = false;
  let cleared = false;
  const consumed = consumeFollowTargetSearchEscape({
    key: 'Escape',
    preventDefault: () => { prevented = true; },
    stopPropagation: () => { stopped = true; },
  }, 'sales', () => { cleared = true; });

  assert.equal(consumed, true);
  assert.equal(prevented, true);
  assert.equal(stopped, true);
  assert.equal(cleared, true);

  assert.equal(consumeFollowTargetSearchEscape({
    key: 'Escape',
    preventDefault: () => assert.fail('empty Escape must remain available to the modal'),
    stopPropagation: () => assert.fail('empty Escape must remain available to the modal'),
  }, '', () => assert.fail('empty Escape must not clear the query')), false);
});

test('partial follower details retain confirmed rows and add a diagnostic without a leading LUID', () => {
  const items = followerDetailLines({
    metricId: 'metric-exact',
    followers: [{ id: 'user-exact', name: 'Confirmed user', type: 'USER' }],
    errors: ['Group name lookup failed'],
    status: 'partial',
  });

  assert.deepEqual(items.map((item) => ({ text: item.text, error: item.error })), [
    { text: 'User - Confirmed user', error: false },
    { text: 'Follower details are partial - Group name lookup failed', error: true },
  ]);
  const joined = items.map((item) => item.text).join(' ');
  assert.doesNotMatch(joined, /No followers yet/);
  // The raw metric LUID must not lead the follower lines any more.
  assert.doesNotMatch(joined, /metric-exact/);
});

test('fork friendly names lead with the source name and never a bare LUID', () => {
  assert.equal(
    forkFriendlyName(
      { name: 'Average Win Rate', filters: [{ field: 'Region', categorical_values: [{ string_value: 'West' }] }] },
      'Average Win Rate',
      '18d03c56-70b4-47ac-9e62-16e815aee431',
    ),
    'Average Win Rate - Region: West',
  );
  // No dimensional filter but a distinct timeframe -> use the timeframe label.
  assert.equal(
    forkFriendlyName(
      { name: 'Average Win Rate', timeframeLabel: 'Last 30 days', filters: [] },
      'Average Win Rate',
      '30654403-3e91-4f1f-a304-21ad1dcb652e',
    ),
    'Average Win Rate - Last 30 days',
  );
  // No extra scope information leaves the business name alone.
  assert.equal(
    forkFriendlyName(undefined, 'Average Win Rate', '30654403-3e91-4f1f-a304-21ad1dcb652e'),
    'Average Win Rate',
  );
  // An unnamed metric carries its own LUID as `name` upstream; that must not
  // lead the label - fall back to the definition name plus the timeframe.
  assert.equal(
    forkFriendlyName(
      { name: '147965d8-11e8-4863-8d04-8104164d0fdf', timeframeLabel: 'Month to date', filters: [] },
      'Deal Size',
      '147965d8-11e8-4863-8d04-8104164d0fdf',
    ),
    'Deal Size - Month to date',
  );
});

test('current user fallback row is searchable and labelled with their real name', () => {
  const named = currentUserFollowTarget('user-1', 'Example User');
  assert.deepEqual(named, { id: 'user-1', kind: 'USER', label: 'Example User (you)', searchText: 'Example User' });
  // Searchable by the REAL name, not only the "(you)" decoration.
  assert.equal(followTargetMatchesQuery(named!, 'example'), true);
  assert.equal(followTargetMatchesQuery(named!, 'user'), true);
  assert.equal(followTargetMatchesQuery(named!, 'you'), true);
  assert.equal(followTargetMatchesQuery(named!, 'nomatch'), false);

  // When the display name is unavailable the row still exists and is selectable.
  const anonymous = currentUserFollowTarget('user-1');
  assert.deepEqual(anonymous, { id: 'user-1', kind: 'USER', label: 'You' });
  assert.equal(currentUserFollowTarget(''), null);
});

test('current user stays in the fetched inventory, decorated and searchable by real username', () => {
  const inventory: FollowTargetChoice[] = [
    { id: 'user-1', kind: 'USER', label: 'Example User' },
    { id: 'user-2', kind: 'USER', label: 'Ada Lovelace' },
    { id: 'group-1', kind: 'GROUP', label: 'Sales' },
  ];
  const resolved = resolveCurrentUserFollowTarget(inventory, 'user-1', 'ignored-session-name');
  // The current user comes from the inventory (real username), decorated with " (you)".
  assert.deepEqual(resolved.currentUser, {
    id: 'user-1',
    kind: 'USER',
    label: 'Example User (you)',
    searchText: 'Example User',
  });
  // Still searchable by the real username, not just "(you)".
  assert.equal(followTargetMatchesQuery(resolved.currentUser!, 'example'), true);
  // The current user is removed from "others" so they are not listed twice.
  assert.deepEqual(resolved.others.map((target) => target.id), ['user-2', 'group-1']);

  // Genuinely absent from the inventory -> synthesize from the session name.
  const absent = resolveCurrentUserFollowTarget(
    [{ id: 'user-2', kind: 'USER', label: 'Ada Lovelace' }],
    'user-1',
    'Example User',
  );
  assert.deepEqual(absent.currentUser, {
    id: 'user-1',
    kind: 'USER',
    label: 'Example User (you)',
    searchText: 'Example User',
  });
  assert.deepEqual(absent.others.map((target) => target.id), ['user-2']);
});

test('row follower summary counts distinct individuals and groups from subscriptions, ignoring my-group membership', () => {
  const followStateWith = (userIds: string[], groupIds: string[]): FollowState => ({
    userFollowsByMetricId: { 'm-1': false },
    groupFollowsByMetricId: {},
    groupFollowerIdsByMetricId: { 'm-1': groupIds },
    userFollowerIdsByMetricId: { 'm-1': userIds },
    followerCountsByMetricId: { 'm-1': userIds.length + groupIds.length },
    errors: [],
    availabilityByMetricId: {
      'm-1': { status: 'available', relationshipStatus: 'available', followerCountStatus: 'available', diagnostics: [] },
    },
  });
  assert.deepEqual(summarizeFollowerRelationships(['m-1'], followStateWith(['u-1'], ['g-1'])), { user: '1', groups: '1' });
  // Adding more followers must move the row counts up, even though the current
  // user is not a member of either group and is not one of the individuals.
  assert.deepEqual(
    summarizeFollowerRelationships(['m-1'], followStateWith(['u-1', 'u-2'], ['g-1', 'g-2'])),
    { user: '2', groups: '2' },
  );
});

test('distinct follower counts dedupe across a definition and degrade gracefully', () => {
  const followState: FollowState = {
    userFollowsByMetricId: {},
    groupFollowsByMetricId: {},
    userFollowerIdsByMetricId: { 'm-1': ['u-1', 'u-2'], 'm-2': ['u-2', 'u-3'] },
    groupFollowerIdsByMetricId: { 'm-1': ['g-1'], 'm-2': ['g-1', 'g-2'] },
    followerCountsByMetricId: {},
    errors: [],
    availabilityByMetricId: {
      'm-1': { status: 'available', relationshipStatus: 'available', followerCountStatus: 'available', diagnostics: [] },
      'm-2': { status: 'available', relationshipStatus: 'available', followerCountStatus: 'available', diagnostics: [] },
    },
  };
  // u-2 and g-1 appear on both metrics but are counted once.
  assert.deepEqual(countDistinctFollowers(['m-1', 'm-2'], followState), {
    individuals: 3,
    groups: 2,
    individualsUnavailable: false,
    groupsUnavailable: false,
  });
});

test('unavailable follow data never renders confirmed zero counts', () => {
  const unavailable = unavailableFollowState(['metric-unavailable'], 'request failed');
  assert.deepEqual(
    summarizeFollowerRelationships(['metric-unavailable'], unavailable),
    { user: 'unavailable', groups: 'unavailable' },
  );
  const unavailableRadius = deletionBlastRadius(countDistinctFollowers(['metric-unavailable'], unavailable));
  // Fully unavailable: honest message, never a confident-but-wrong "0".
  assert.equal(unavailableRadius.summary, 'Follower reach is unavailable for the selected metrics.');
  assert.doesNotMatch(unavailableRadius.summary, /\b0\b/);
  assert.equal(unavailableRadius.note, null);

  const partial = mergeFollowStates([{
    userFollowsByMetricId: { 'metric-confirmed': true },
    groupFollowsByMetricId: {},
    userFollowerIdsByMetricId: { 'metric-confirmed': ['user-a', 'user-b'] },
    groupFollowerIdsByMetricId: { 'metric-confirmed': ['group-a'] },
    followerCountsByMetricId: { 'metric-confirmed': 3 },
    errors: [],
    availabilityByMetricId: {
      'metric-confirmed': {
        status: 'available',
        relationshipStatus: 'available',
        followerCountStatus: 'available', diagnostics: [],
      },
    },
  }, unavailable]);
  // The row summary shows the confirmed distinct counts, flagged partial where unknown.
  assert.deepEqual(
    summarizeFollowerRelationships(['metric-confirmed', 'metric-unavailable'], partial),
    { user: 'at least 2', groups: 'at least 1' },
  );
  // The delete blast radius keeps the totals it has and appends a partial note.
  const partialRadius = deletionBlastRadius(
    countDistinctFollowers(['metric-confirmed', 'metric-unavailable'], partial),
  );
  assert.equal(partialRadius.summary, '2 individuals and 1 group follow the selected metrics.');
  assert.match(partialRadius.note ?? '', /true reach may be higher/);
});

test('canonical variant responses preserve outcomes and reject unknown result shapes', () => {
  const body = {
    attempted: 4, created: 2, existing: 1, failed: 1, pendingVisibility: 1,
    results: [
      { sourceMetricId: 'm-1', status: 'created', creationStatus: 'created', metricId: 'new-1', requestedSpecification: {} },
      { sourceMetricId: 'm-2', status: 'pending_visibility', reconciliationStatus: 'pending_visibility', creationStatus: 'created', metricId: 'new-2', requestedSpecification: {} },
      { sourceMetricId: 'm-3', status: 'failed', creationStatus: 'unknown', requestedSpecification: {} },
      {
        sourceMetricId: 'm-4',
        status: 'visible',
        creationStatus: 'existing',
        reconciliationStatus: 'visible',
        requestedSpecification: {},
      },
    ],
  };
  const summary = decodeVariantResponse({ ok: true, status: 207 }, body);
  assert.equal(summary.created, 2);
  assert.equal(summary.existing, 1);
  assert.equal(summary.pendingVisibility, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.results[0].metricId, 'new-1');
  assert.equal(summary.results[0].creationStatus, 'created');
  assert.equal(summary.results[1].status, 'pending_visibility');
  assert.equal(summary.results[1].creationStatus, 'created');
  assert.equal(summary.results[1].reconciliationStatus, 'pending_visibility');
  assert.equal(summary.results[3].status, 'visible');
  assert.equal(summary.results[3].creationStatus, 'existing');
  assert.equal(summary.results[3].reconciliationStatus, 'visible');
  assert.throws(() => decodeVariantResponse({ ok: true, status: 200 }, {
    ...body, results: [{ sourceMetricId: 'm-1', status: 'unexpected', requestedSpecification: {} }],
  }), /invalid variant receipt/i);
});

test('registry action counts preserve partial outcomes', () => {
  const counts = registryActionCounts([
    { key: '1', metricId: 'm-1', metricLabel: 'One', status: 'created' },
    { key: '2', metricId: 'm-2', metricLabel: 'Two', status: 'failed' },
    { key: '3', metricId: 'm-3', metricLabel: 'Three', status: 'pending' },
  ]);
  assert.equal(counts.created, 1);
  assert.equal(counts.failed, 1);
  assert.equal(counts.pending, 1);
});

test('fork registry results preserve creation, reconciliation, and requested specification', () => {
  const requestedSpecification = {
    measurement_period: { range: 'RANGE_BY_CONFIG', last_x_period: { period: 30 } },
    filters: [{ field: 'Region', values: ['West'] }],
  };
  const item = forkRegistryActionItem({
    sourceMetricId: 'm-1',
    metricId: 'fork-1',
    status: 'pending_visibility',
    creationStatus: 'existing',
    reconciliationStatus: 'pending_visibility',
    requestedSpecification,
  }, 'Sales', 0);
  assert.equal(item.status, 'pending');
  assert.equal(item.creationStatus, 'existing');
  assert.equal(item.reconciliationStatus, 'pending_visibility');
  assert.equal(item.requestedSpecification, requestedSpecification);
  assert.equal(registryActionLabel('fork', item), 'already exists; visibility pending');
  assert.deepEqual(forkRegistryActionCounts([item]), {
    unknown: 0,
    notAttempted: 0,
    created: 0,
    existing: 1,
    visible: 0,
    pendingVisibility: 1,
    ownershipMismatch: 0,
    failed: 0,
  });
});

test('missing follower IDs never become confirmed zero while other metric counts load', () => {
  const partial=unavailableFollowState([], '');
  assert.deepEqual(summarizeFollowerRelationships(['not-loaded'],partial),{user:'unavailable',groups:'unavailable'});
});
test('known follower IDs remain counts when only membership context or total count is unavailable', () => {
  const state=unavailableFollowState(['metric'], 'Group context unavailable');
  state.userFollowerIdsByMetricId={metric:['user']};state.groupFollowerIdsByMetricId={metric:['group']};
  state.availabilityByMetricId!.metric.followerIdsStatus='available';
  assert.deepEqual(summarizeFollowerRelationships(['metric'],state),{user:'1',groups:'1'});
});
