import {
  DimensionMemberCountSchema,
  DimensionValuePageSchema,
  FilterDimensionFieldSchema,
} from '@pulse-metric-studio/shared';
import { z } from 'zod';
import { pulseRequest } from './api/client';
import { ownedPulseUrl, type SessionOwner } from './shell/session-events';

export interface DimensionContext { snapshotId?: string; sourceContextId?: string; owner?: SessionOwner | null }

/** Dimension discovery is read-only. All variants use registryApi.fork. */
export const pulseDimensionalForkApi = {
  fields: async (sourceMetricIds: string[], context: DimensionContext = {}) => {
    return z.object({ fields: FilterDimensionFieldSchema.array(), sourceContextId: z.string().optional() }).parse(
      await pulseRequest(ownedPulseUrl('/api/pulse/dimensions', context.owner), 'POST', { sourceMetricIds, snapshotId: context.snapshotId, sourceContextId: context.sourceContextId }),
    );
  },
  count: async (sourceMetricIds: string[], fieldId: string, context: DimensionContext = {}) => {
    return DimensionMemberCountSchema.parse(
      await pulseRequest(ownedPulseUrl('/api/pulse/dimensions/count', context.owner), 'POST', { sourceMetricIds, fieldId, snapshotId: context.snapshotId, sourceContextId: context.sourceContextId }),
    );
  },
  values: async (sourceMetricIds: string[], fieldId: string, search: string, options: { all?: boolean } & DimensionContext = {}) => {
    return DimensionValuePageSchema.parse(
      await pulseRequest(ownedPulseUrl('/api/pulse/dimensions/values', options.owner), 'POST', { sourceMetricIds, fieldId, search, all: options.all, snapshotId: options.snapshotId, sourceContextId: options.sourceContextId }),
    );
  },
};
