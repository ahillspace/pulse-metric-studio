import type { FollowState } from './registry/view-types';

/** Coverage belongs to the retained metrics, never to the last completed batch. */
function withFollowCoverage(state: FollowState, requested = Boolean(state.coverage)): FollowState {
  const metrics = Object.values(state.availabilityByMetricId ?? {});
  if (!requested && !metrics.some(metric => metric.canLoadMore !== undefined)) return state;
  const statuses = metrics.map(metric => metric.relationshipStatus ?? metric.status);
  return { ...state, coverage: {
    status: statuses.every(status => status === 'available') ? 'available'
      : statuses.length && statuses.every(status => status === 'unavailable') ? 'unavailable' : 'partial',
    canLoadMore: metrics.some(metric => metric.canLoadMore === true),
  } };
}

/** Restrict evidence before merging it so an obsolete overlapping metric cannot leak through. */
export function selectFollowMetrics(state: FollowState, metricIds: string[]): FollowState {
  const selected = new Set(metricIds);
  const select = <T>(values: Record<string, T> | undefined): Record<string, T> =>
    Object.fromEntries(Object.entries(values ?? {}).filter(([id]) => selected.has(id)));
  return withFollowCoverage({ ...state,
    userFollowsByMetricId: select(state.userFollowsByMetricId), groupFollowsByMetricId: select(state.groupFollowsByMetricId),
    userFollowerIdsByMetricId: select(state.userFollowerIdsByMetricId), groupFollowerIdsByMetricId: select(state.groupFollowerIdsByMetricId),
    followerCountsByMetricId: select(state.followerCountsByMetricId), availabilityByMetricId: select(state.availabilityByMetricId),
    errors: state.errors.filter(error => metricIds.some(id => error.startsWith(`${id}:`))),
  });
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
  }
  return withFollowCoverage(merged, states.some(state => Boolean(state.coverage)));
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

/** Short row label. Diagnostics belong in {@link followStateTitle}, never in the label. */
export function followStateLabel(followState: FollowState | null, metricId: string): string {
  const userFollows = followState?.userFollowsByMetricId[metricId] === true;
  const groupFollows = followState?.groupFollowsByMetricId[metricId] === true;
  const availability = followState?.availabilityByMetricId?.[metricId];
  const relationshipStatus = availability?.relationshipStatus ?? availability?.status;
  const followerCount = followState?.followerCountsByMetricId[metricId];
  const count = typeof followerCount === 'number' ? ` (${followerCount})` : '';
  if (userFollows && groupFollows) return `You + group${count}`;
  if (userFollows) return `You follow${count}`;
  if (groupFollows) return `Group follows${count}`;
  if (relationshipStatus === 'not_requested' || !relationshipStatus) return 'Loading followers...';
  if (relationshipStatus === 'available') return `Not followed${count}`;
  if (availability?.canLoadMore === true) return `More followers to load${count}`;
  return 'Followers unavailable';
}

/** Row tooltip with every reason the label could not be confirmed, or undefined when nothing needs explaining. */
export function followStateTitle(followState: FollowState | null, metricId: string): string | undefined {
  const availability = followState?.availabilityByMetricId?.[metricId];
  if (!availability) return undefined;
  const sentence = (message: string) => /[.!?]$/.test(message.trim()) ? message.trim() : `${message.trim()}.`;
  const messages = availability.diagnostics.map(diagnostic => diagnostic.message).filter(Boolean).map(sentence);
  if (availability.followerCountStatus === 'unavailable') messages.push('Follower count unavailable.');
  if (availability.canLoadMore === true && !messages.some(message => /Load more/.test(message)))
    messages.push('More followers to load. Select Load more followers to continue.');
  const distinct = [...new Set(messages)];
  return distinct.length ? distinct.join(' ') : undefined;
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
