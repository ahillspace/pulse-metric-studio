import { TableauThrottleMetadataSchema, type TableauThrottleMetadata } from '@pulse-metric-studio/shared';
export function mutationMetadata(error: unknown, unsent = false): { sent: boolean; throttle?: TableauThrottleMetadata } {
  const candidate = error !== null && typeof error === 'object' ? error as { sent?: unknown; throttle?: unknown } : {};
  const sent = !unsent && candidate.sent !== false;
  const parsed = TableauThrottleMetadataSchema.safeParse(candidate.throttle);
  return { sent, ...(parsed.success ? { throttle: { ...parsed.data, sent } } : {}) };
}
export function latestThrottle(items: Array<{ throttle?: TableauThrottleMetadata }>): TableauThrottleMetadata | undefined {
  return items.flatMap(item => item.throttle ? [item.throttle] : []).sort((left, right) => right.retryAt - left.retryAt)[0];
}
