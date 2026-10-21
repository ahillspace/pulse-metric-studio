import {
  DimensionMemberCountSchema,
  DimensionValuePageSchema,
  FilterDimensionFieldSchema,
} from '@pulse-metric-studio/shared';
import { z } from 'zod';
import { pulseRequest } from './api/client';

/** Dimension discovery is read-only. All variants use registryApi.fork. */
export const pulseDimensionalForkApi = {
  fields: async (sourceMetricIds: string[]) => {
    return z.object({ fields: FilterDimensionFieldSchema.array() }).parse(
      await pulseRequest('/api/pulse/dimensions', 'POST', { sourceMetricIds }),
    );
  },
  count: async (sourceMetricIds: string[], fieldId: string) => {
    return DimensionMemberCountSchema.parse(
      await pulseRequest('/api/pulse/dimensions/count', 'POST', { sourceMetricIds, fieldId }),
    );
  },
  values: async (sourceMetricIds: string[], fieldId: string, search: string, options: { all?: boolean } = {}) => {
    return DimensionValuePageSchema.parse(
      await pulseRequest('/api/pulse/dimensions/values', 'POST', { sourceMetricIds, fieldId, search, ...options }),
    );
  },
};
