import { getSession } from "@pulse-metric-studio/core";
import {
  PulseFollowCommandSchema,
  PulseVariantCommandSchema,
} from "@pulse-metric-studio/shared";
import type { FastifyInstance } from "fastify";
import { requirePulseOwner } from "../application/context.js";
import { getExistingMetrics } from "../application/inventory.js";
import {
  followTargets,
  getFollowersDetail,
  getFollowState,
  getFollowTargets,
  listUserGroupIds,
  unfollowTargets,
} from "../application/subscriptions.js";
import {
  registerPulseWorkflowRoutes,
  type PulseWorkflowDependencies,
} from "../http/workflow-routes.js";
import { pulseDimensionalForkService } from "./dimensional-fork-service.js";
import {
  forkPlanHttpStatus,
  pulseForkPlanService,
  type PulseForkPlanService,
} from "./fork-plan-service.js";

function requireSession() {
  const s = getSession();
  if (!s) {
    const err = new Error("Not connected to Tableau") as Error & {
      statusCode?: number;
    };
    err.statusCode = 401;
    throw err;
  }
  return s;
}

export function registerPulseRoutes(
  app: FastifyInstance,
  dependencies: PulseWorkflowDependencies & {
    forkPlanService?: Pick<PulseForkPlanService, "forkMetrics">;
  } = {},
): void {
  registerPulseWorkflowRoutes(app, dependencies);

  const forkPlanService = dependencies.forkPlanService ?? pulseForkPlanService;

  app.get("/api/pulse/status", async () => ({
    enabled: true,
    module: "pulse",
  }));

  app.get("/api/pulse/existing-metrics", async (req) => {
    const session = requireSession();
    const { datasourceLuid } = req.query as { datasourceLuid?: string };
    if (!datasourceLuid)
      throw app.httpErrors.badRequest(
        "datasourceLuid query parameter is required",
      );
    return getExistingMetrics(session, datasourceLuid);
  });

  app.get("/api/pulse/dimensions", async (req) => {
    const session = requireSession();
    const query = (req.query ?? {}) as Record<string, unknown>;
    return pulseDimensionalForkService.listEligibleDimensions(
      session,
      repeatedQueryValues(query.sourceMetricId),
    );
  });

  // Field IDs are field names and may contain "/" (for example
  // "Country/Region"); the desktop transport rejects encoded separators in
  // paths, so the field travels as a query parameter.
  app.get("/api/pulse/dimensions/count", async (req) => {
    const session = requireSession();
    const query = dimensionQuery(app, req.query);
    return pulseDimensionalForkService.countDimensionMembers(session, {
      sourceMetricIds: query.sourceMetricIds,
      fieldId: query.fieldId,
    });
  });

  app.get("/api/pulse/dimensions/values", async (req) => {
    const session = requireSession();
    const query = dimensionQuery(app, req.query);
    return pulseDimensionalForkService.listDimensionValues(session, query);
  });

  app.post("/api/pulse/metrics/fork", async (req, reply) => {
    const parsed = PulseVariantCommandSchema.safeParse(req.body);
    if (!parsed.success) throw app.httpErrors.badRequest(parsed.error.message);
    const session = requirePulseOwner(parsed.data.context);
    const summary = await forkPlanService.forkMetrics(session, parsed.data);
    return reply.code(forkPlanHttpStatus(summary)).send(summary);
  });

  app.post("/api/pulse/follow-state", async (req) => {
    const session = requireSession();
    const body = req.body as { metricIds?: string[]; selectedGroupId?: string };
    if (!Array.isArray(body.metricIds))
      throw app.httpErrors.badRequest("metricIds array required");
    const selectedGroupId = String(body.selectedGroupId ?? "").trim();
    let groups: Array<{ id: string; name: string }> = [];
    let groupContextUnavailable = false;
    if (!selectedGroupId) {
      try {
        groups = await listUserGroupIds(session, session.userId);
      } catch {
        groupContextUnavailable = true;
      }
    }
    return getFollowState(
      session,
      session.userId,
      groups.map((g) => g.id),
      body.metricIds,
      {
        selectedGroupId: selectedGroupId || undefined,
        groupContextUnavailable,
      },
    );
  });

  app.get("/api/pulse/groups", async () => {
    const session = requireSession();
    return { groups: await listUserGroupIds(session, session.userId) };
  });

  app.get("/api/pulse/follow-targets", async () => {
    const session = requireSession();
    // No server-side search: REST API 3.27 rejects `name:has:` (400065). The
    // client loads the full inventory once and filters locally.
    return getFollowTargets(session);
  });

  app.post("/api/pulse/follow", async (req) => {
    const parsed = PulseFollowCommandSchema.safeParse(req.body);
    if (!parsed.success) throw app.httpErrors.badRequest(parsed.error.message);
    const session = requirePulseOwner(parsed.data.context);
    const operations = parsed.data.operations;
    const results = await followTargets(session, { operations });
    return {
      results,
      terminated: results.some(
        (result) => result.code === "authentication_required",
      ),
      stopped: results.some(
        (result) =>
          result.code === "authentication_required" ||
          result.code === "subscription_interrupted",
      ),
    };
  });

  app.post("/api/pulse/unfollow", async (req) => {
    const parsed = PulseFollowCommandSchema.safeParse(req.body);
    if (!parsed.success) throw app.httpErrors.badRequest(parsed.error.message);
    const session = requirePulseOwner(parsed.data.context);
    const operations = parsed.data.operations;
    const results = await unfollowTargets(session, { operations });
    return {
      results,
      terminated: results.some(
        (result) => result.code === "authentication_required",
      ),
      stopped: results.some(
        (result) =>
          result.code === "authentication_required" ||
          result.code === "subscription_interrupted",
      ),
    };
  });

  app.post("/api/pulse/followers-detail", async (req) => {
    const session = requireSession();
    const body = req.body as { metricIds?: string[] };
    if (!Array.isArray(body.metricIds))
      throw app.httpErrors.badRequest("metricIds array required");
    return { details: await getFollowersDetail(session, body.metricIds) };
  });
}

const MAX_DIMENSION_SOURCE_METRICS = 500;
const MAX_DIMENSION_ID_LENGTH = 512;
const MAX_DIMENSION_SEARCH_LENGTH = 256;

/** Bounded dimension query parameters; oversized input is rejected before any Tableau call. */
export function dimensionQuery(app: FastifyInstance, raw: unknown) {
  const query = (raw ?? {}) as Record<string, unknown>;
  const sourceMetricIds = repeatedQueryValues(query.sourceMetricId);
  const fieldId = typeof query.fieldId === "string" ? query.fieldId : "";
  const search = typeof query.search === "string" ? query.search : undefined;
  if (
    sourceMetricIds.length > MAX_DIMENSION_SOURCE_METRICS ||
    sourceMetricIds.some((id) => id.length > MAX_DIMENSION_ID_LENGTH) ||
    fieldId.length > MAX_DIMENSION_ID_LENGTH ||
    (search?.length ?? 0) > MAX_DIMENSION_SEARCH_LENGTH
  )
    throw app.httpErrors.badRequest("The dimension request is too large.");
  return { sourceMetricIds, fieldId, search, all: query.all === "1" || query.all === "true" };
}

export function repeatedQueryValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((entry) => String(entry));
  return value === undefined || value === null ? [] : [String(value)];
}
