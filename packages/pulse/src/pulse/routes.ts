import { getSession } from "@pulse-metric-studio/core";
import {
  PulseFollowCommandSchema,
  PulseVariantCommandSchema,
} from "@pulse-metric-studio/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
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
import {
  PulseDimensionalForkError,
  type PulseDimensionalForkService,
  pulseDimensionalForkService,
} from "./dimensional-fork-service.js";
import {
  forkPlanHttpStatus,
  pulseForkPlanService,
  type PulseForkPlanService,
} from "./fork-plan-service.js";

const DimensionSourcesSchema = z.object({
  sourceMetricIds: z.array(z.string().trim().min(1).max(512)).min(1),
}).strict();
const DimensionFieldSchema = DimensionSourcesSchema.extend({
  fieldId: z.string().trim().min(1).max(512),
});
const DimensionValuesSchema = DimensionFieldSchema.extend({
  search: z.string().max(256).optional(),
  all: z.boolean().optional(),
});

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
    dimensionalForkService?: Pick<PulseDimensionalForkService,
      "listEligibleDimensions" | "countDimensionMembers" | "listDimensionValues">;
  } = {},
): void {
  registerPulseWorkflowRoutes(app, dependencies);

  const forkPlanService = dependencies.forkPlanService ?? pulseForkPlanService;
  const dimensions = dependencies.dimensionalForkService ?? pulseDimensionalForkService;

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

  app.post("/api/pulse/dimensions", async (req) => {
    const session = requireSession();
    const body = DimensionSourcesSchema.safeParse(req.body);
    if (!body.success) throw new PulseDimensionalForkError(body.error.message, 400);
    return dimensions.listEligibleDimensions(
      session,
      body.data.sourceMetricIds,
    );
  });

  app.post("/api/pulse/dimensions/count", async (req) => {
    const session = requireSession();
    const body = DimensionFieldSchema.safeParse(req.body);
    if (!body.success) throw new PulseDimensionalForkError(body.error.message, 400);
    return dimensions.countDimensionMembers(session, body.data);
  });

  app.post("/api/pulse/dimensions/values", async (req) => {
    const session = requireSession();
    const body = DimensionValuesSchema.safeParse(req.body);
    if (!body.success) throw new PulseDimensionalForkError(body.error.message, 400);
    return dimensions.listDimensionValues(session, body.data);
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
