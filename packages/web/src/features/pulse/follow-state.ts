import type { FollowState } from '../../api/client';

export function mergeFollowStates(states: FollowState[]): FollowState {
  return states.reduce<FollowState>((merged, state) => ({
    userFollowsByMetricId: { ...merged.userFollowsByMetricId, ...state.userFollowsByMetricId },
    groupFollowsByMetricId: { ...merged.groupFollowsByMetricId, ...state.groupFollowsByMetricId },
    groupFollowerIdsByMetricId: { ...merged.groupFollowerIdsByMetricId, ...state.groupFollowerIdsByMetricId },
    userFollowerIdsByMetricId: { ...merged.userFollowerIdsByMetricId, ...state.userFollowerIdsByMetricId },
    followerCountsByMetricId: { ...merged.followerCountsByMetricId, ...state.followerCountsByMetricId },
    errors: [...merged.errors, ...state.errors],
    availabilityByMetricId: { ...merged.availabilityByMetricId, ...state.availabilityByMetricId },
    groupContextUnavailable: merged.groupContextUnavailable || state.groupContextUnavailable,
  }), {
    userFollowsByMetricId: {},
    groupFollowsByMetricId: {},
    groupFollowerIdsByMetricId: {},
    userFollowerIdsByMetricId: {},
    followerCountsByMetricId: {},
    errors: [],
    availabilityByMetricId: {},
    groupContextUnavailable: false,
  });
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
