/** Display helpers also accept incomplete snapshots while follower reads are unavailable. */
export type { PulseFollowOperation as FollowTargetOperation } from "@pulse-metric-studio/shared";
export type FollowTargetOperationResult =
  import("@pulse-metric-studio/shared").PulseFollowOperationResult;
export type FollowState = Omit<
  import("@pulse-metric-studio/shared").PulseFollowState,
  | "groupFollowerIdsByMetricId"
  | "userFollowerIdsByMetricId"
  | "availabilityByMetricId"
  | "groupContextUnavailable"
  | "selectedGroupId"
> &
  Partial<
    Pick<
      import("@pulse-metric-studio/shared").PulseFollowState,
      | "groupFollowerIdsByMetricId"
      | "userFollowerIdsByMetricId"
      | "availabilityByMetricId"
      | "groupContextUnavailable"
      | "selectedGroupId"
    >
  >;
export type FollowersDetail = Omit<
  import("@pulse-metric-studio/shared").PulseFollowersDetail,
  "status" | "diagnostics"
> &
  Partial<
    Pick<
      import("@pulse-metric-studio/shared").PulseFollowersDetail,
      "status" | "diagnostics"
    >
  >;
