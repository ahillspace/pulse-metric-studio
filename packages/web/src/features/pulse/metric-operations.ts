import type { MetricSelection, Op } from '@pulse-metric-studio/shared';

type MetricOp = Extract<Op, { op: 'ADD_METRIC' | 'MODIFY_METRIC' }>;
type Granularity = NonNullable<MetricOp['minGranularity']>;
const GRANULARITY: Record<Granularity, Exclude<MetricSelection['minGranularity'], ''>> = {
  DAY: 'DAY', WEEK: 'WEEK', MONTH: 'MONTH', QUARTER: 'QUARTER', YEAR: 'YEAR',
  GRANULARITY_BY_DAY: 'DAY', GRANULARITY_BY_WEEK: 'WEEK', GRANULARITY_BY_MONTH: 'MONTH',
  GRANULARITY_BY_QUARTER: 'QUARTER', GRANULARITY_BY_YEAR: 'YEAR',
};
const EDITABLE = ['aggregation', 'timeDimensionFieldId', 'cumulative', 'format', 'sentiment', 'name', 'description', 'minGranularity', 'temporality'] as const satisfies ReadonlyArray<keyof MetricSelection>;

export function enforceMetricConstraints(metric: MetricSelection): MetricSelection {
  return metric.requiresUserAgg || metric.aggregation !== 'SUM' || metric.format === 'PERCENT' || metric.temporality === 'LATEST'
    ? { ...metric, cumulative: false } : metric;
}

export function applyMetricOperation(base: MetricSelection, op: MetricOp): MetricSelection {
  const locks = new Set(base.locks.map((key) => key === 'timeField' ? 'timeDimensionFieldId' : key));
  const patch: Partial<MetricSelection> = {};
  for (const key of EDITABLE) {
    if (locks.has(key) || op[key] === undefined) continue;
    if (key === 'minGranularity') patch.minGranularity = GRANULARITY[op.minGranularity!];
    else Object.assign(patch, { [key]: op[key] });
  }
  return enforceMetricConstraints({ ...base, ...patch, ...(op.op === 'ADD_METRIC' ? { active: true } : {}) });
}
