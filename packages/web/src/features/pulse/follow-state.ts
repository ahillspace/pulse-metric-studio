import type { FollowState } from './registry/view-types';

/** Restrict evidence before merging it so an obsolete overlapping metric cannot leak through. */
export function selectFollowMetrics(state: FollowState, metricIds: string[]): FollowState {
  const selected = new Set(metricIds);
  const select = <T>(values: Record<string, T> | undefined): Record<string, T> =>
    Object.fromEntries(Object.entries(values ?? {}).filter(([id]) => selected.has(id)));
  return { ...state,
    userFollowsByMetricId: select(state.userFollowsByMetricId), groupFollowsByMetricId: select(state.groupFollowsByMetricId),
    userFollowerIdsByMetricId: select(state.userFollowerIdsByMetricId), groupFollowerIdsByMetricId: select(state.groupFollowerIdsByMetricId),
    followerCountsByMetricId: select(state.followerCountsByMetricId), availabilityByMetricId: select(state.availabilityByMetricId),
    errors: state.errors.filter(error => metricIds.some(id => error.startsWith(`${id}:`))),
  };
}

/** A failed targeted replacement must not leave old identities looking current. */
export function replaceFollowMetrics(previous: FollowState | null, replacement: FollowState, metricIds: string[]): FollowState {
  if (!previous) return replacement;
  const retained = structuredClone(previous);
  for (const id of metricIds) {
    delete retained.userFollowsByMetricId[id];
    delete retained.groupFollowsByMetricId[id];
    if (retained.groupFollowerIdsByMetricId) delete retained.groupFollowerIdsByMetricId[id];
    if (retained.userFollowerIdsByMetricId) delete retained.userFollowerIdsByMetricId[id];
    delete retained.followerCountsByMetricId[id];
    delete retained.availabilityByMetricId?.[id];
  }
  retained.errors = retained.errors.filter((error) => !metricIds.some((id) => error.startsWith(`${id}:`)));
  return mergeFollowStates([retained, replacement]);
}

/** Detail-only reads never erase independently acquired summary counts. */
export function replaceFollowDetails(previous: FollowState | null, replacement: FollowState, metricIds: string[]): FollowState {
  const result = replaceFollowMetrics(previous, replacement, metricIds);
  if (!previous) return result;
  for (const id of metricIds) {
    if (replacement.availabilityByMetricId?.[id]?.followerCountStatus !== 'not_requested') continue;
    if (Object.hasOwn(previous.followerCountsByMetricId, id)) result.followerCountsByMetricId[id] = previous.followerCountsByMetricId[id]!;
    const availability = result.availabilityByMetricId?.[id];
    if (availability) result.availabilityByMetricId![id] = { ...availability, followerCountStatus: previous.availabilityByMetricId?.[id]?.followerCountStatus ?? 'not_requested' };
  }
  return result;
}

export function mergeFollowStates(states: FollowState[]): FollowState {
  const assign = <T>(target: Record<string, T>, source: Record<string, T> | undefined) => {
    for (const [key, value] of Object.entries(source ?? {}))
      Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
  };
  const merged: FollowState = {
    userFollowsByMetricId: {}, groupFollowsByMetricId: {}, groupFollowerIdsByMetricId: {}, userFollowerIdsByMetricId: {},
    followerCountsByMetricId: {}, errors: [], availabilityByMetricId: {}, groupContextUnavailable: false,
  };
  for (const state of states) {
    assign(merged.userFollowsByMetricId, state.userFollowsByMetricId);
    assign(merged.groupFollowsByMetricId, state.groupFollowsByMetricId);
    assign(merged.groupFollowerIdsByMetricId!, state.groupFollowerIdsByMetricId);
    assign(merged.userFollowerIdsByMetricId!, state.userFollowerIdsByMetricId);
    assign(merged.followerCountsByMetricId, state.followerCountsByMetricId);
    assign(merged.availabilityByMetricId!, state.availabilityByMetricId);
    merged.errors.push(...state.errors);
    merged.groupContextUnavailable ||= state.groupContextUnavailable;
    if (state.coverage) merged.coverage = state.coverage;
  }
  return merged;
}

export function metricIsFollowed(followState: FollowState | null, metricId: string): boolean {
  if (
    followState?.userFollowsByMetricId[metricId]
    || followState?.groupFollowsByMetricId[metricId]
  ) return true;
  const availability = followState?.availabilityByMetricId?.[metricId];
  if (!availability) return false;
  return (availability.relationshipStatus ?? availability.status) !== 'available';
}

export function followStateLabel(followState: FollowState | null, metricId: string): string {
  const userFollows = followState?.userFollowsByMetricId[metricId] === true;
  const groupFollows = followState?.groupFollowsByMetricId[metricId] === true;
  const availability = followState?.availabilityByMetricId?.[metricId];
  const relationshipStatus = availability?.relationshipStatus ?? availability?.status;
  const followerCountStatus = availability?.followerCountStatus
    ?? (availability?.status === 'available' ? 'available' : undefined);
  const relationshipLabel = userFollows && groupFollows
    ? 'You + group'
    : userFollows
      ? 'You follow'
      : groupFollows
        ? 'Group follows'
        : (relationshipStatus === 'not_requested' || !relationshipStatus)
          ? 'Follow details not loaded'
        : relationshipStatus === 'unavailable'
          ? 'Follow state unavailable'
          : relationshipStatus === 'partial'
            ? 'Follow state partial'
            : 'Not followed';
  const followerCount = followState?.followerCountsByMetricId[metricId];
  const countLabel = typeof followerCount === 'number' ? ` (${followerCount})` : '';
  const diagnostics = [
    relationshipStatus === 'partial' && (userFollows || groupFollows) ? 'follow state partial' : null,
    followerCountStatus === 'unavailable' ? 'follower count unavailable' : null,
  ].filter((message): message is string => message !== null);
  return `${relationshipLabel}${countLabel}${diagnostics.length > 0 ? ` - ${diagnostics.join(' - ')}` : ''}`;
}

export function unavailableFollowState(metricIds: string[], message: string): FollowState {
  return {
    userFollowsByMetricId: {},
    groupFollowsByMetricId: {},
    groupFollowerIdsByMetricId: {},
    userFollowerIdsByMetricId: {},
    followerCountsByMetricId: {},
    errors: metricIds.map((metricId) => `${metricId}: ${message}`),
    availabilityByMetricId: Object.fromEntries(metricIds.map((metricId) => [metricId, {
      status: 'unavailable' as const,
      relationshipStatus: 'unavailable' as const,
      followerCountStatus: 'unavailable' as const,
      diagnostics: [{ message }],
    }])),
    groupContextUnavailable: false,
  };
}
