import { getSession, getSessionContext, isSessionCurrent, TableauError, TableauThrottleError, type TableauSession } from "@pulse-metric-studio/core";
import {
  PulseFollowCommandSchema,
  PulseVariantCommandSchema,
} from "@pulse-metric-studio/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requirePulseOwner } from "../application/context.js";
import { PulseApplicationError } from "../application/errors.js";
import { loadPulseInventory } from "../application/inventory-snapshots.js";
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
import { latestThrottle } from '../application/mutation-metadata.js';
import { pulseOperationErrorMessage } from './operation-errors.js';

async function dimensionOperation<T>(session: TableauSession, operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (!(error instanceof TableauError) || error instanceof TableauThrottleError) throw error;
    throw new PulseDimensionalForkError(pulseOperationErrorMessage(error, 'dimension-fields', [session.token]), error.kind === 'auth' ? 401 : 502);
  }
}

const DimensionSourcesSchema = z.object({
  sourceMetricIds: z.array(z.string().trim().min(1).max(512)).min(1),
  snapshotId: z.string().min(1).max(512).optional(),
  sourceContextId: z.string().min(1).max(512).optional(),
}).strict();
const DimensionFieldSchema = DimensionSourcesSchema.extend({
  fieldId: z.string().min(1).max(1024).refine((value) => value.trim().length > 0),
});
const DimensionValuesSchema = DimensionFieldSchema.extend({
  search: z.string().max(256).optional(),
  all: z.boolean().optional(),
});

const ExpectedOwnerSchema = z.object({
  connectionId: z.string().min(1).max(512),
  serverUrl: z.string().url().max(2048),
  siteId: z.string().min(1).max(512),
  userId: z.string().min(1).max(512),
  sessionGeneration: z.number().int().nonnegative(),
}).strict();

function requireSession(request?: FastifyRequest) {
  const s = getSession();
  const encodedOwner = (request?.query as { expectedOwner?: unknown } | undefined)?.expectedOwner;
  if (encodedOwner !== undefined) {
    let input: unknown;
    try {
      if (typeof encodedOwner !== "string" || encodedOwner.length > 8192) throw new Error();
      input = JSON.parse(encodedOwner);
    } catch { throw new PulseApplicationError("invalid_request", "expectedOwner must be a valid session owner."); }
    const parsed = ExpectedOwnerSchema.safeParse(input);
    if (!parsed.success) throw new PulseApplicationError("invalid_request", "expectedOwner must be a valid session owner.");
    const owner = parsed.data;
    const context = s && getSessionContext(s);
    if (!s || !context || !isSessionCurrent(s) || owner.connectionId !== context.connectionId ||
      owner.sessionGeneration !== context.generation || owner.serverUrl !== s.serverUrl ||
      owner.siteId !== s.siteId || owner.userId !== s.userId)
      throw new PulseApplicationError("tableau_context_changed", "The Tableau session changed before this request started. Retry from the current connection.", 409);
  }
  // Older callers omit expectedOwner; retain their existing arrival-session contract.
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
    const session = requireSession(req);
    const { datasourceLuid, refresh } = req.query as { datasourceLuid?: string; refresh?: string };
    if (!datasourceLuid)
      throw app.httpErrors.badRequest(
        "datasourceLuid query parameter is required",
      );
    return loadPulseInventory(session, datasourceLuid, { refresh: refresh === "true" });
  });

  app.post("/api/pulse/dimensions", async (req) => {
    const session = requireSession(req);
    const body = DimensionSourcesSchema.safeParse(req.body);
    if (!body.success) throw new PulseDimensionalForkError(body.error.message, 400);
    return dimensionOperation(session, () => dimensions.listEligibleDimensions(
      session,
      body.data.sourceMetricIds, body.data,
    ));
  });

  app.post("/api/pulse/dimensions/count", async (req) => {
    const session = requireSession(req);
    const body = DimensionFieldSchema.safeParse(req.body);
    if (!body.success) throw new PulseDimensionalForkError(body.error.message, 400);
    return dimensionOperation(session, () => dimensions.countDimensionMembers(session, body.data));
  });

  app.post("/api/pulse/dimensions/values", async (req) => {
    const session = requireSession(req);
    const body = DimensionValuesSchema.safeParse(req.body);
    if (!body.success) throw new PulseDimensionalForkError(body.error.message, 400);
    return dimensionOperation(session, () => dimensions.listDimensionValues(session, body.data));
  });

  app.post("/api/pulse/metrics/fork", async (req, reply) => {
    const parsed = PulseVariantCommandSchema.safeParse(req.body);
    if (!parsed.success) throw app.httpErrors.badRequest(parsed.error.message);
    const session = requirePulseOwner(parsed.data.context, requireSession(req));
    const summary = await forkPlanService.forkMetrics(session, parsed.data);
    return reply.code(forkPlanHttpStatus(summary)).send(summary);
  });

  app.post("/api/pulse/follow-state", async (req) => {
    const session = requireSession(req);
    const body = req.body as { metricIds?: string[]; selectedGroupId?: string; detail?: boolean; snapshotId?: string; continueCoverage?: boolean; personalOnly?: boolean; refresh?: boolean };
    if (!Array.isArray(body.metricIds))
      throw app.httpErrors.badRequest("metricIds array required");
    const selectedGroupId = String(body.selectedGroupId ?? "").trim();
    let groups: Array<{ id: string; name: string }> = [];
    let groupContextUnavailable = false;
    if (body.detail !== undefined && typeof body.detail !== 'boolean') throw app.httpErrors.badRequest('detail must be a boolean');
    if (body.refresh !== undefined && typeof body.refresh !== 'boolean') throw app.httpErrors.badRequest('refresh must be a boolean');
    if (body.detail !== false && !body.personalOnly && !selectedGroupId) {
      try {
        groups = await listUserGroupIds(session, session.userId);
      } catch (error) {
        if (error instanceof Error && 'kind' in error && error.kind === 'auth') throw error;
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
        detail: body.detail,
        snapshotId: body.snapshotId,
        continueCoverage: body.continueCoverage,
        personalOnly: body.personalOnly,
        refresh: body.refresh,
      },
    );
  });

  app.get("/api/pulse/groups", async (req) => {
    const session = requireSession(req);
    return { groups: await listUserGroupIds(session, session.userId) };
  });

  app.get("/api/pulse/follow-targets", async (req) => {
    const session = requireSession(req);
    // No server-side search: REST API 3.27 rejects `name:has:` (400065). The
    // client loads the full inventory once and filters locally.
    return getFollowTargets(session);
  });

  app.post("/api/pulse/follow", async (req, reply) => {
    const parsed = PulseFollowCommandSchema.safeParse(req.body);
    if (!parsed.success) throw app.httpErrors.badRequest(parsed.error.message);
    const session = requirePulseOwner(parsed.data.context, requireSession(req));
    const operations = parsed.data.operations;
    const results = await followTargets(session, { operations });
    const throttle = latestThrottle(results), sent = results.some(result => result.sent !== false);
    if (throttle) reply.code(sent ? 207 : 429);
    return {
      sent,
      ...(throttle ? { throttle: { ...throttle, sent } } : {}),
      results,
      terminated: results.some(
        (result) => result.code === "authentication_required",
      ),
      stopped: results.some(
        (result) =>
          result.code === "authentication_required" ||
          result.code === "subscription_interrupted" || result.throttle !== undefined,
      ),
    };
  });

  app.post("/api/pulse/unfollow", async (req, reply) => {
    const parsed = PulseFollowCommandSchema.safeParse(req.body);
    if (!parsed.success) throw app.httpErrors.badRequest(parsed.error.message);
    const session = requirePulseOwner(parsed.data.context, requireSession(req));
    const operations = parsed.data.operations;
    const results = await unfollowTargets(session, { operations });
    const throttle = latestThrottle(results), sent = results.some(result => result.sent !== false);
    if (throttle) reply.code(sent ? 207 : 429);
    return {
      sent,
      ...(throttle ? { throttle: { ...throttle, sent } } : {}),
      results,
      terminated: results.some(
        (result) => result.code === "authentication_required",
      ),
      stopped: results.some(
        (result) =>
          result.code === "authentication_required" ||
          result.code === "subscription_interrupted" || result.throttle !== undefined,
      ),
    };
  });

  app.post("/api/pulse/followers-detail", async (req) => {
    const session = requireSession(req);
    const body = req.body as { metricIds?: string[] };
    if (!Array.isArray(body.metricIds))
      throw app.httpErrors.badRequest("metricIds array required");
    return { details: await getFollowersDetail(session, body.metricIds) };
  });
}
