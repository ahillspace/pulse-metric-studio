import {
  PulseInventoryResponseSchema,
  TableauThrottleStatusSchema,
  TableauThrottleMetadataSchema,
  PulseFollowStateSchema,
  PulseFollowTargetsSchema,
  PulseFollowResultsSchema,
  PulseFollowersDetailsSchema,
  PulseVariantSummarySchema,
  type PulseDraftContext,
  type PulseFollowOperation,
  type PulseVariantRequestV1,
} from "@pulse-metric-studio/shared";
import { captureSessionOwner, notifySessionExpired, ownedPulseUrl, type SessionOwner } from "../shell/session-events";
import { cancelMutationJob, mutationJobRequest, type MutationJobObserver } from "./mutation-jobs";
import { extractErrorMessage } from "../../../api/client";
import { PulseApiError, pulseRequest } from "./client";

export const registryApi = {
  throttle: async (owner = captureSessionOwner()) => TableauThrottleStatusSchema.parse(await pulseRequest(ownedPulseUrl("/api/tableau/throttle", owner))),
  inventory: async (context: PulseDraftContext, owner = captureSessionOwner(), options?: { refresh?: boolean }) =>
    PulseInventoryResponseSchema.parse(
      await pulseRequest(
        ownedPulseUrl(`/api/pulse/existing-metrics?datasourceLuid=${encodeURIComponent(context.datasourceLuid)}${options?.refresh ? "&refresh=true" : ""}`, owner),
      ),
    ),
  followState: async (metricIds: string[], detail = true, owner = captureSessionOwner(), options: { snapshotId?: string; continueCoverage?: boolean; refresh?: boolean } = {}) =>
    PulseFollowStateSchema.parse(
      await pulseRequest(ownedPulseUrl("/api/pulse/follow-state", owner), "POST", { metricIds, detail, ...options }),
    ),
  followTargets: async (owner = captureSessionOwner()) =>
    PulseFollowTargetsSchema.parse(
      await pulseRequest(ownedPulseUrl("/api/pulse/follow-targets", owner)),
    ),
  followers: async (metricIds: string[], owner = captureSessionOwner()) =>
    PulseFollowersDetailsSchema.parse(
      await pulseRequest(ownedPulseUrl("/api/pulse/followers-detail", owner), "POST", { metricIds }),
    ),
  follow: async (
    context: PulseDraftContext,
    operations: PulseFollowOperation[],
    owner = captureSessionOwner(),
    observe?: MutationJobObserver,
  ) => subscriptionRequest("/api/pulse/follow", context, operations, owner, observe),
  unfollow: async (
    context: PulseDraftContext,
    operations: PulseFollowOperation[],
    owner = captureSessionOwner(),
    observe?: MutationJobObserver,
  ) => subscriptionRequest("/api/pulse/unfollow", context, operations, owner, observe),
  fork: async (context: PulseDraftContext, request: PulseVariantRequestV1, owner = captureSessionOwner(), options: { snapshotId?: string; sourceContextId?: string } = {}, observe?: MutationJobObserver) => {
    const result = await mutationJobRequest("/api/pulse/metrics/fork", { ...request, context, ...options }, owner, observe);
    return decodeVariantResponse(result, result.data, owner);
  },
  cancelJob: (id: string, owner = captureSessionOwner()) => cancelMutationJob(id, owner),
};

export type RegistryApi = Omit<typeof registryApi, "throttle"> & { throttle?: typeof registryApi.throttle };

async function subscriptionRequest(
  path: string,
  context: PulseDraftContext,
  operations: PulseFollowOperation[],
  owner: SessionOwner | null,
  observe?: MutationJobObserver,
) {
  const response = await mutationJobRequest(path, { context, operations }, owner, observe);
  const data = response.data;
  const parsed = PulseFollowResultsSchema.safeParse(data);
  if (response.status === 401 || (parsed.success && parsed.data.terminated))
    notifySessionExpired(owner);
  if (parsed.success) {
    const throttle = TableauThrottleMetadataSchema.safeParse((data as { throttle?: unknown } | null)?.throttle);
    return { ...parsed.data, ...(throttle.success ? { throttle: throttle.data } : {}) };
  }
  if (!response.ok)
    throw new PulseApiError(
      extractErrorMessage(data, response.status),
      response.status,
      undefined, undefined,
      TableauThrottleMetadataSchema.safeParse((data as { throttle?: unknown } | null)?.throttle).success ? TableauThrottleMetadataSchema.parse((data as { throttle?: unknown }).throttle) : undefined,
    );
  throw new Error(
    "The server returned an invalid subscription receipt. Inspect Tableau before retrying.",
  );
}

export function decodeVariantResponse(
  response: { ok: boolean; status: number },
  data: unknown,
  owner: SessionOwner | null = null,
) {
  const parsed = PulseVariantSummarySchema.safeParse(data);
  if (response.status === 401 || (parsed.success && parsed.data.terminated))
    notifySessionExpired(owner);
  if (parsed.success)
    return {
      ...parsed.data,
      ...(!response.ok
        ? { error: parsed.data.throttle ? "Tableau is limiting requests. Wait for the request limit to clear before retrying." : extractErrorMessage(data, response.status) }
        : {}),
    };
  if (!response.ok)
    throw new PulseApiError(
      extractErrorMessage(data, response.status),
      response.status,
      undefined, undefined,
      TableauThrottleMetadataSchema.safeParse((data as { throttle?: unknown } | null)?.throttle).success ? TableauThrottleMetadataSchema.parse((data as { throttle?: unknown }).throttle) : undefined,
    );
  throw new Error(
    "The server returned an invalid variant receipt. Inspect Tableau before retrying.",
  );
}
