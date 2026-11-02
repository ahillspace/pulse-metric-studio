import {
  PulseInventoryResponseSchema,
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
import { desktopFetch } from "../../../desktop-transport";
import { extractErrorMessage } from "../../../api/client";
import { PulseApiError, pulseRequest } from "./client";

export const registryApi = {
  inventory: async (context: PulseDraftContext, owner = captureSessionOwner()) =>
    PulseInventoryResponseSchema.parse(
      await pulseRequest(
        ownedPulseUrl(`/api/pulse/existing-metrics?datasourceLuid=${encodeURIComponent(context.datasourceLuid)}`, owner),
      ),
    ),
  followState: async (metricIds: string[], detail = true, owner = captureSessionOwner()) =>
    PulseFollowStateSchema.parse(
      await pulseRequest(ownedPulseUrl("/api/pulse/follow-state", owner), "POST", { metricIds, detail }),
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
  ) => subscriptionRequest("/api/pulse/follow", context, operations, owner),
  unfollow: async (
    context: PulseDraftContext,
    operations: PulseFollowOperation[],
    owner = captureSessionOwner(),
  ) => subscriptionRequest("/api/pulse/unfollow", context, operations, owner),
  fork: async (context: PulseDraftContext, request: PulseVariantRequestV1, owner = captureSessionOwner()) => {
    const response = await desktopFetch(ownedPulseUrl("/api/pulse/metrics/fork", owner), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...request, context }),
    });
    return decodeVariantResponse(
      response,
      await response.json().catch(() => null),
      owner,
    );
  },
};

export type RegistryApi = typeof registryApi;

async function subscriptionRequest(
  path: string,
  context: PulseDraftContext,
  operations: PulseFollowOperation[],
  owner: SessionOwner | null,
) {
  const response = await desktopFetch(ownedPulseUrl(path, owner), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ context, operations }),
  });
  const data = await response.json().catch(() => null);
  const parsed = PulseFollowResultsSchema.safeParse(data);
  if (response.status === 401 || (parsed.success && parsed.data.terminated))
    notifySessionExpired(owner);
  if (parsed.success) return parsed.data;
  if (!response.ok)
    throw new PulseApiError(
      extractErrorMessage(data, response.status),
      response.status,
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
        ? { error: extractErrorMessage(data, response.status) }
        : {}),
    };
  if (!response.ok)
    throw new PulseApiError(
      extractErrorMessage(data, response.status),
      response.status,
    );
  throw new Error(
    "The server returned an invalid variant receipt. Inspect Tableau before retrying.",
  );
}
