import type { PulsePublishReceipt } from "@pulse-metric-studio/shared";

/** Only stages requested by the selected publication follow mode need attention. */
export function publicationFollowProblems(follow: PulsePublishReceipt["follow"]) {
  if (!follow.requested || follow.mode === "none") return [];
  const stages = follow.mode === "self"
    ? follow.subscriptions
    : [follow.group, follow.membership, ...follow.subscriptions];
  return stages.filter(item => ["failed", "unknown", "not_attempted"].includes(item.status));
}
