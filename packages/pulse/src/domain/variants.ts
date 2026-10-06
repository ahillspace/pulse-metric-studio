import type { TimeframeSpec } from '@pulse-metric-studio/shared';
export function timeframeMeasurementPeriod(timeframe: TimeframeSpec): Record<string, unknown> {
  return {
    granularity: timeframe.granularity,
    range: timeframe.range,
    ...(timeframe.lastXPeriod ? { last_x_period: structuredClone(timeframe.lastXPeriod) } : {}),
  };
}

