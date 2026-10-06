import {
  DimensionMemberCountSchema,
  DimensionValuePageSchema,
  FilterDimensionFieldSchema,
} from '@pulse-metric-studio/shared';
import { z } from 'zod';
import { pulseRequest } from './api/client';

function sourceContextQuery(sourceMetricIds: string[]): URLSearchParams {
  const query = new URLSearchParams();
  for (const metricId of sourceMetricIds) query.append('sourceMetricId', metricId);
  return query;
}

/** Dimension discovery is read-only. All variants use registryApi.fork. */
export const pulseDimensionalForkApi = {
  fields: async (sourceMetricIds: string[]) => {
    const query = sourceContextQuery(sourceMetricIds);
    return z.object({ fields: FilterDimensionFieldSchema.array() }).parse(
      await pulseRequest(`/api/pulse/dimensions?${query}`),
    );
  },
  count: async (sourceMetricIds: string[], fieldId: string) => {
    const query = sourceContextQuery(sourceMetricIds);
    return DimensionMemberCountSchema.parse(
      await pulseRequest(`/api/pulse/dimensions/${encodeURIComponent(fieldId)}/count?${query}`),
    );
  },
  values: async (sourceMetricIds: string[], fieldId: string, search: string, options: { all?: boolean } = {}) => {
    const query = sourceContextQuery(sourceMetricIds);
    if (search) query.set('search', search);
    if (options.all) query.set('all', '1');
    return DimensionValuePageSchema.parse(
      await pulseRequest(`/api/pulse/dimensions/${encodeURIComponent(fieldId)}/values?${query}`),
    );
  },
};
