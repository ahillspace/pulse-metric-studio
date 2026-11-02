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
import { notifySessionExpired } from "../shell/session-events";
import { desktopFetch } from "../../../desktop-transport";
import { extractErrorMessage } from "../../../api/client";
import { PulseApiError, pulseRequest } from "./client";

export const registryApi = {
  inventory: async (context: PulseDraftContext) =>
    PulseInventoryResponseSchema.parse(
      await pulseRequest(
        `/api/pulse/existing-metrics?datasourceLuid=${encodeURIComponent(context.datasourceLuid)}`,
      ),
    ),
  followState: async (metricIds: string[]) =>
    PulseFollowStateSchema.parse(
      await pulseRequest("/api/pulse/follow-state", "POST", { metricIds }),
    ),
  followTargets: async () =>
    PulseFollowTargetsSchema.parse(
      await pulseRequest("/api/pulse/follow-targets"),
    ),
  followers: async (metricIds: string[]) =>
    PulseFollowersDetailsSchema.parse(
      await pulseRequest("/api/pulse/followers-detail", "POST", { metricIds }),
    ),
  follow: async (
    context: PulseDraftContext,
    operations: PulseFollowOperation[],
  ) => subscriptionRequest("/api/pulse/follow", context, operations),
  unfollow: async (
    context: PulseDraftContext,
    operations: PulseFollowOperation[],
  ) => subscriptionRequest("/api/pulse/unfollow", context, operations),
  fork: async (context: PulseDraftContext, request: PulseVariantRequestV1) => {
    const response = await desktopFetch("/api/pulse/metrics/fork", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...request, context }),
    });
    return decodeVariantResponse(
      response,
      await response.json().catch(() => null),
    );
  },
};

export type RegistryApi = typeof registryApi;

async function subscriptionRequest(
  path: string,
  context: PulseDraftContext,
  operations: PulseFollowOperation[],
) {
  const response = await desktopFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ context, operations }),
  });
  const data = await response.json().catch(() => null);
  const parsed = PulseFollowResultsSchema.safeParse(data);
  if (response.status === 401 || (parsed.success && parsed.data.terminated))
    notifySessionExpired();
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
) {
  const parsed = PulseVariantSummarySchema.safeParse(data);
  if (response.status === 401 || (parsed.success && parsed.data.terminated))
    notifySessionExpired();
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
