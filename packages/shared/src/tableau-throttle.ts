import { z } from 'zod';

export const TableauThrottleStatusSchema = z.object({
  throttled: z.boolean(),
  retryAt: z.number().int().nonnegative().nullable(),
  serverTime: z.number().int().nonnegative(),
  reason: z.literal('throttle').nullable(),
});
export type TableauThrottleStatus = z.infer<typeof TableauThrottleStatusSchema>;

export const TableauThrottleMetadataSchema = z.object({
  retryAt: z.number().int().nonnegative(),
  serverTime: z.number().int().nonnegative(),
  reason: z.literal('throttle'),
  sent: z.boolean(),
});
export type TableauThrottleMetadata = z.infer<typeof TableauThrottleMetadataSchema>;
