import type { TableauSession } from "@pulse-metric-studio/core";
import {
  TableauError,
  apiPath,
  getJson,
  isPastEndError,
} from "@pulse-metric-studio/core";
import type {
  PulseFollowOperation,
  PulseFollowOperationResult,
  PulseFollowState,
  PulseFollowTarget,
  PulseFollowTargets,
  PulseFollowersDetail,
} from "@pulse-metric-studio/shared";
import {
  boundedProviderDiagnostic,
  diagnosticMessage,
  type PulseProviderDiagnostic,
} from "../pulse/provider-diagnostics.js";
import {
  SubscriptionBatchInterrupted,
  type FollowerCountBatchResult,
  type SubscriptionRecord,
} from "../pulse/pulse-client.js";

import {
  canonicalFollowOperations,
  canonicalIds,
  deduplicateFollowers,
  followOperationKey,
  followOperationKeyParts,
  isRecord,
  mapWithConcurrency,
  operationResult,
  recordCollection,
  stringValue,
  touch,
} from "./registry-collections.js";
import {
  defaultDependencies,
  type SubscriptionDependencies,
} from "./registry-dependencies.js";
const PROVIDER_CONCURRENCY = 5;
const NAME_CACHE_TTL_MS = 300000;
const MAX_NAME_CACHE_ENTRIES = 512;
export const FOLLOW_OPERATION_BATCH_LIMIT = 200;
interface NameCacheEntry {
  name: string | null;
  expiresAt: number;
}

const nameCache = new Map<string, NameCacheEntry>();
export type MetricAvailability =
  PulseFollowState["availabilityByMetricId"][string];

export type FollowStateResult = PulseFollowState;

export async function getFollowState(
  session: TableauSession,
  userId: string,
  userGroupIds: string[],
  metricIds: string[],
  options: { selectedGroupId?: string; groupContextUnavailable?: boolean } = {},
  dependencies: SubscriptionDependencies = defaultDependencies,
): Promise<FollowStateResult> {
  const uniqueMetricIds = canonicalIds(metricIds);
  const selectedGroupId = String(options.selectedGroupId ?? "").trim();
  const result: FollowStateResult = {
    userFollowsByMetricId: {},
    groupFollowsByMetricId: {},
    groupFollowerIdsByMetricId: {},
    userFollowerIdsByMetricId: {},
    followerCountsByMetricId: {},
    availabilityByMetricId: {},
    selectedGroupId: selectedGroupId || null,
    groupContextUnavailable: options.groupContextUnavailable === true,
    errors: [],
  };
  if (uniqueMetricIds.length === 0) return result;

  let countResult: FollowerCountBatchResult;
  try {
    countResult = await dependencies.followerCounts(session, uniqueMetricIds);
  } catch (error) {
    if (error instanceof TableauError && error.kind === "auth") throw error;
    const message = diagnosticMessage(boundedProviderDiagnostic(error));
    countResult = {
      countsByMetricId: {},
      errorsByMetricId: Object.fromEntries(
        uniqueMetricIds.map((metricId) => [metricId, { message }]),
      ),
    };
  }
  Object.assign(result.followerCountsByMetricId, countResult.countsByMetricId);

  const subscriptionResults = await mapWithConcurrency(
    uniqueMetricIds,
    PROVIDER_CONCURRENCY,
    async (metricId) => {
      try {
        return {
          metricId,
          subscriptions: await dependencies.listSubscriptions(
            session,
            metricId,
          ),
        };
      } catch (error) {
        if (error instanceof TableauError && error.kind === "auth") throw error;
        return {
          metricId,
          subscriptions: null,
          diagnostic: boundedProviderDiagnostic(error),
        };
      }
    },
  );

  const groupIds = new Set(
    selectedGroupId ? [selectedGroupId] : canonicalIds(userGroupIds),
  );
  for (const entry of subscriptionResults) {
    const diagnostics: PulseProviderDiagnostic[] = [];
    const countError = countResult.errorsByMetricId[entry.metricId];
    if (countError) diagnostics.push(countError);
    if (entry.diagnostic) diagnostics.push(entry.diagnostic);
    if (result.groupContextUnavailable)
      diagnostics.push({ message: "Tableau group context is unavailable." });
    const hasUnknownFollowerType =
      entry.subscriptions?.some(
        (subscription) => subscription.follower.type === "UNKNOWN",
      ) === true;
    if (hasUnknownFollowerType) {
      diagnostics.push({
        message:
          "Tableau returned a follower with an unsupported follower type.",
      });
    }

    if (entry.subscriptions) {
      const userFollows = entry.subscriptions.some(
        (subscription) =>
          subscription.follower.type === "USER" &&
          subscription.follower.id === userId,
      );
      const groupFollows = entry.subscriptions.some(
        (subscription) =>
          subscription.follower.type === "GROUP" &&
          groupIds.has(subscription.follower.id),
      );
      if (userFollows || !hasUnknownFollowerType) {
        result.userFollowsByMetricId[entry.metricId] = userFollows;
      }
      if (
        !result.groupContextUnavailable &&
        (groupFollows || !hasUnknownFollowerType)
      ) {
        result.groupFollowsByMetricId[entry.metricId] = groupFollows;
      }
      // Distinct group followers for the row summary. This is independent of the
      // current user's group membership, so a group the user is not in still
      // counts, and the count updates as followers are added or removed.
      result.groupFollowerIdsByMetricId[entry.metricId] = [
        ...new Set(
          entry.subscriptions
            .filter((subscription) => subscription.follower.type === "GROUP")
            .map((subscription) => subscription.follower.id),
        ),
      ];
      // Distinct individual (USER) followers for the row summary, mirroring the
      // group list. Independent of whether the current user is one of them, so
      // the count reflects every person following, not just "I follow".
      result.userFollowerIdsByMetricId[entry.metricId] = [
        ...new Set(
          entry.subscriptions
            .filter((subscription) => subscription.follower.type === "USER")
            .map((subscription) => subscription.follower.id),
        ),
      ];
    }

    const subscriptionAvailable = entry.subscriptions !== null;
    const countAvailable = !countError && typeof result.followerCountsByMetricId[entry.metricId] === "number";
    const relationshipStatus: MetricAvailability["relationshipStatus"] =
      !subscriptionAvailable
        ? "unavailable"
        : result.groupContextUnavailable || hasUnknownFollowerType
          ? "partial"
          : "available";
    const followerCountStatus: MetricAvailability["followerCountStatus"] =
      countAvailable ? "available" : "unavailable";
    const status: MetricAvailability["status"] =
      relationshipStatus === "available" && countAvailable
        ? "available"
        : relationshipStatus !== "unavailable" || countAvailable
          ? "partial"
          : "unavailable";
    result.availabilityByMetricId[entry.metricId] = {
      status,
      relationshipStatus,
      followerIdsStatus: !subscriptionAvailable ? "unavailable" : hasUnknownFollowerType ? "partial" : "available",
      followerCountStatus,
      diagnostics,
    };
    result.errors.push(
      ...diagnostics.map(
        (diagnostic) => `${entry.metricId}: ${diagnosticMessage(diagnostic)}`,
      ),
    );
  }
  return result;
}

export async function listUserGroupIds(
  session: TableauSession,
  userId: string,
): Promise<Array<{ id: string; name: string }>> {
  const out: Array<{ id: string; name: string }> = [];
  let pageNumber = 1;
  const pageSize = 1000;
  for (;;) {
    let data: unknown;
    try {
      data = await getJson<unknown>(
        session,
        apiPath(
          session,
          `/sites/${encodeURIComponent(session.siteId)}/users/${encodeURIComponent(userId)}/groups?pageSize=${pageSize}&pageNumber=${pageNumber}`,
        ),
      );
    } catch (error) {
      if (isPastEndError(error)) break;
      throw error;
    }
    if (!isRecord(data))
      throw new Error("Unsupported Tableau user-groups response shape.");
    let groupsRaw: unknown;
    if (Object.hasOwn(data, "groups")) {
      if (!isRecord(data.groups))
        throw new Error("Unsupported Tableau user-groups response shape.");
      groupsRaw = data.groups.group;
    } else if (Object.hasOwn(data, "group")) {
      groupsRaw = data.group;
    } else {
      throw new Error("Unsupported Tableau user-groups response shape.");
    }
    const groups = recordCollection(groupsRaw, "Tableau user-groups");
    out.push(
      ...groups.map((group) => {
        const id = stringValue(group.id ?? group.luid);
        const name = stringValue(group.name);
        if (!id || !name)
          throw new Error("Unsupported Tableau user-groups record shape.");
        return { id, name };
      }),
    );
    if (groups.length < pageSize) break;
    pageNumber++;
  }
  return out;
}

export type ListTarget = PulseFollowTarget;

export type FollowTargetOperation = PulseFollowOperation;

export type FollowTargetOperationStatus = PulseFollowOperationResult["status"];

export type FollowTargetOperationResult = PulseFollowOperationResult;

export function buildFollowTargets(
  groups: Array<{ id: string; name: string }>,
  users: Array<{ id: string; name: string }>,
): ListTarget[] {
  return [
    ...groups.map((group) => ({ ...group, kind: "GROUP" as const })),
    ...users.map((user) => ({ ...user, kind: "USER" as const })),
  ].sort((left, right) =>
    String(left.name ?? "").localeCompare(String(right.name ?? "")),
  );
}

export async function followTargets(
  session: TableauSession,
  input: { operations: FollowTargetOperation[] },
  dependencies: SubscriptionDependencies = defaultDependencies,
): Promise<FollowTargetOperationResult[]> {
  const operations = canonicalFollowOperations(input.operations);
  const results = new Map<string, FollowTargetOperationResult>();
  const subscriptionsByMetricId = new Map<
    string,
    SubscriptionRecord[] | null
  >();
  const metricIds = [
    ...new Set(operations.map((operation) => operation.metricId)),
  ];

  try {
    await mapWithConcurrency(
      metricIds,
      PROVIDER_CONCURRENCY,
      async (metricId) => {
        try {
          subscriptionsByMetricId.set(
            metricId,
            await dependencies.listSubscriptions(session, metricId),
          );
        } catch (error) {
          if (error instanceof TableauError && error.kind === "auth")
            throw error;
          subscriptionsByMetricId.set(metricId, null);
        }
      },
    );
  } catch (error) {
    if (!(error instanceof TableauError) || error.kind !== "auth") throw error;
    return operations.map((operation) => ({
      ...operationResult(
        operation,
        "not_attempted",
        false,
        "The Tableau session ended before subscriptions could be checked.",
      ),
      code: "authentication_required",
    }));
  }

  const pending = operations.filter((operation) => {
    const subscriptions = subscriptionsByMetricId.get(operation.metricId);
    const alreadyFollowed = subscriptions?.some(
      (subscription) =>
        subscription.follower.id === operation.target.id &&
        subscription.follower.type === operation.target.kind,
    );
    if (!alreadyFollowed) return true;
    results.set(
      followOperationKey(operation),
      operationResult(operation, "already_followed", true),
    );
    return false;
  });

  let terminated = false;
  for (const kind of ["GROUP", "USER"] as const) {
    if (terminated) break;
    const kindOperations = pending.filter(
      (operation) => operation.target.kind === kind,
    );
    for (
      let index = 0;
      index < kindOperations.length;
      index += FOLLOW_OPERATION_BATCH_LIMIT
    ) {
      const batch = kindOperations.slice(
        index,
        index + FOLLOW_OPERATION_BATCH_LIMIT,
      );
      try {
        const created =
          kind === "GROUP"
            ? await dependencies.createGroupSubscriptions(
                session,
                batch.map((operation) => ({
                  metricId: operation.metricId,
                  groupId: operation.target.id,
                })),
              )
            : await dependencies.createUserSubscriptions(
                session,
                batch.map((operation) => ({
                  metricId: operation.metricId,
                  userId: operation.target.id,
                })),
              );
        const createdByKey = new Map(
          created.map((result) => [
            followOperationKeyParts(result.metricId, kind, result.targetId),
            result,
          ]),
        );
        for (const operation of batch) {
          const createdResult = createdByKey.get(followOperationKey(operation));
          if (!createdResult) {
            results.set(
              followOperationKey(operation),
              operationResult(
                operation,
                "failed",
                false,
                "Tableau returned no result for this metric and target.",
              ),
            );
          } else if (createdResult.ok) {
            results.set(
              followOperationKey(operation),
              operationResult(
                operation,
                createdResult.alreadyExists ? "already_followed" : "followed",
                true,
              ),
            );
          } else {
            results.set(
              followOperationKey(operation),
              operationResult(
                operation,
                "failed",
                false,
                createdResult.error ?? "Tableau rejected the follow request.",
              ),
            );
          }
        }
      } catch (error) {
        const message = diagnosticMessage(boundedProviderDiagnostic(error));
        if (
          error instanceof SubscriptionBatchInterrupted ||
          (error instanceof TableauError && error.kind === "auth")
        ) {
          terminated = true;
          const completed =
            error instanceof SubscriptionBatchInterrupted
              ? error.completed
              : [];
          for (const item of completed) {
            const operation = batch.find(
              (candidate) =>
                candidate.metricId === item.metricId &&
                candidate.target.id === item.targetId,
            );
            if (operation)
              results.set(
                followOperationKey(operation),
                operationResult(
                  operation,
                  item.ok
                    ? item.alreadyExists
                      ? "already_followed"
                      : "followed"
                    : "failed",
                  item.ok,
                  item.error,
                ),
              );
          }
          for (const operation of batch) {
            if (results.has(followOperationKey(operation))) continue;
            const rejected =
              error instanceof SubscriptionBatchInterrupted &&
              error.failed.metricId === operation.metricId &&
              error.failed.targetId === operation.target.id;
            const authentication = error.kind === "auth";
            results.set(followOperationKey(operation), {
              ...operationResult(
                operation,
                rejected
                  ? authentication
                    ? "failed"
                    : "unknown"
                  : "not_attempted",
                false,
                message,
              ),
              code: authentication
                ? "authentication_required"
                : "subscription_interrupted",
            });
          }
          break;
        }
        for (const operation of batch) {
          results.set(
            followOperationKey(operation),
            operationResult(operation, "failed", false, message),
          );
        }
      }
    }
  }

  return operations.map(
    (operation) =>
      results.get(followOperationKey(operation)) ??
      operationResult(
        operation,
        terminated ? "not_attempted" : "failed",
        false,
        terminated
          ? "The batch stopped before this follow was sent."
          : "The follow operation did not produce a result.",
      ),
  );
}

export async function unfollowTargets(
  session: TableauSession,
  input: { operations: FollowTargetOperation[] },
  dependencies: SubscriptionDependencies = defaultDependencies,
): Promise<FollowTargetOperationResult[]> {
  const operations = canonicalFollowOperations(input.operations);
  const results: FollowTargetOperationResult[] = [];
  const subscriptionsByMetricId = new Map<string, SubscriptionRecord[]>();
  let terminated = false;
  for (const operation of operations) {
    if (terminated) {
      results.push(
        operationResult(
          operation,
          "not_attempted",
          false,
          "The batch stopped before this unfollow was sent.",
        ),
      );
      continue;
    }
    let attempted = false;
    try {
      let subscriptions = subscriptionsByMetricId.get(operation.metricId);
      if (!subscriptions) {
        subscriptions = await dependencies.listSubscriptions(
          session,
          operation.metricId,
        );
        subscriptionsByMetricId.set(operation.metricId, subscriptions);
      }
      const matches = subscriptions.filter(
        (subscription) =>
          subscription.follower.id === operation.target.id &&
          subscription.follower.type === operation.target.kind,
      );
      if (!matches.length) {
        results.push(operationResult(operation, "not_followed", true));
        continue;
      }
      if (matches.some((subscription) => !subscription.id)) {
        results.push(
          operationResult(
            operation,
            "failed",
            false,
            "A matching subscription has no deletable subscription identifier.",
          ),
        );
        continue;
      }
      for (const subscription of matches) {
        attempted = true;
        await dependencies.deleteSubscription(session, subscription.id!);
      }
      results.push(operationResult(operation, "unfollowed", true));
    } catch (error) {
      const auth = error instanceof TableauError && error.kind === "auth";
      const unknown =
        attempted &&
        (!(error instanceof TableauError) ||
          error.kind === "network" ||
          error.status >= 500);
      terminated = auth || unknown;
      results.push({
        ...operationResult(
          operation,
          unknown ? "unknown" : auth && !attempted ? "not_attempted" : "failed",
          false,
          diagnosticMessage(boundedProviderDiagnostic(error)),
        ),
        ...(auth
          ? { code: "authentication_required" }
          : unknown
            ? { code: "subscription_interrupted" }
            : {}),
      });
    }
  }
  return results;
}

export type FollowersDetail = PulseFollowersDetail;

export async function getFollowersDetail(
  session: TableauSession,
  metricIds: string[],
  dependencies: SubscriptionDependencies = defaultDependencies,
): Promise<FollowersDetail[]> {
  const uniqueMetricIds = canonicalIds(metricIds);
  const loaded = await mapWithConcurrency(
    uniqueMetricIds,
    PROVIDER_CONCURRENCY,
    async (metricId) => {
      try {
        return {
          metricId,
          subscriptions: await dependencies.listSubscriptions(
            session,
            metricId,
          ),
        };
      } catch (error) {
        if (error instanceof TableauError && error.kind === "auth") throw error;
        return {
          metricId,
          subscriptions: null,
          diagnostic: boundedProviderDiagnostic(error),
        };
      }
    },
  );

  const followerKeys = new Map<
    string,
    { id: string; type: SubscriptionRecord["follower"]["type"]; name?: string }
  >();
  for (const entry of loaded) {
    for (const subscription of entry.subscriptions ?? []) {
      const follower = subscription.follower;
      followerKeys.set(`${follower.type}\u0000${follower.id}`, follower);
    }
  }
  const entries = [...followerKeys.entries()];
  const resolvedNames = new Map<
    string,
    { name: string; diagnostic?: PulseProviderDiagnostic }
  >();

  // Group names come from a single site-group listing (Tableau REST has no
  // query-single-group endpoint), resolved once and cached for every group
  // follower across the requested metrics.
  const groupIdsToResolve = [
    ...new Set(
      entries
        .filter(([, follower]) => !follower.name && follower.type === "GROUP")
        .map(([, follower]) => follower.id),
    ),
  ];
  let groupNames = new Map<string, string>();
  let groupResolutionDiagnostic: PulseProviderDiagnostic | undefined;
  if (groupIdsToResolve.length > 0) {
    try {
      groupNames = await cachedGroupNames(
        session,
        groupIdsToResolve,
        dependencies,
      );
    } catch (error) {
      if (error instanceof TableauError && error.kind === "auth") throw error;
      groupResolutionDiagnostic = boundedProviderDiagnostic(error);
    }
  }

  await mapWithConcurrency(
    entries,
    PROVIDER_CONCURRENCY,
    async ([key, follower]) => {
      if (follower.name) {
        resolvedNames.set(key, { name: follower.name });
        return;
      }
      if (follower.type === "GROUP") {
        const name = groupNames.get(follower.id);
        if (name) {
          resolvedNames.set(key, { name });
        } else {
          resolvedNames.set(key, {
            name: follower.id,
            diagnostic: groupResolutionDiagnostic ?? {
              message: `Group ${follower.id} was not found in the site group listing.`,
            },
          });
        }
        return;
      }
      if (follower.type === "USER") {
        try {
          const name = await cachedUserName(session, follower.id, dependencies);
          resolvedNames.set(key, { name: name ?? follower.id });
        } catch (error) {
          if (error instanceof TableauError && error.kind === "auth")
            throw error;
          resolvedNames.set(key, {
            name: follower.id,
            diagnostic: boundedProviderDiagnostic(error),
          });
        }
        return;
      }
      resolvedNames.set(key, {
        name: follower.id,
        diagnostic: {
          message: `Follower ${follower.id} has an unsupported follower type.`,
        },
      });
    },
  );

  return loaded.map((entry) => {
    if (!entry.subscriptions) {
      const diagnostic = entry.diagnostic ?? {
        message: "Follower details are unavailable.",
      };
      return {
        metricId: entry.metricId,
        followers: [],
        status: "unavailable" as const,
        diagnostics: [diagnostic],
        errors: [diagnosticMessage(diagnostic)],
      };
    }
    const diagnostics: PulseProviderDiagnostic[] = [];
    const followers = entry.subscriptions.map((subscription) => {
      const follower = subscription.follower;
      const resolved = resolvedNames.get(
        `${follower.type}\u0000${follower.id}`,
      );
      if (resolved?.diagnostic) diagnostics.push(resolved.diagnostic);
      return {
        id: follower.id,
        name: resolved?.name ?? follower.name ?? follower.id,
        type: follower.type,
      };
    });
    return {
      metricId: entry.metricId,
      followers: deduplicateFollowers(followers),
      status:
        diagnostics.length > 0 ? ("partial" as const) : ("available" as const),
      diagnostics,
      errors: diagnostics.map(diagnosticMessage),
    };
  });
}

async function cachedUserName(
  session: TableauSession,
  userId: string,
  dependencies: SubscriptionDependencies,
): Promise<string | null> {
  const now = Date.now();
  const key = nameCacheKey(session, "USER", userId);
  const cached = nameCache.get(key);
  if (cached && cached.expiresAt > now) {
    touch(nameCache, key, cached);
    return cached.name;
  }
  const name = await dependencies.getUserName(session, userId);
  nameCache.set(key, { name, expiresAt: now + NAME_CACHE_TTL_MS });
  evictNameCache();
  return name;
}

/**
 * Resolve group ids to names, hitting the cache first and falling back to a
 * single site-group listing for the remaining ids. Returns only the ids that
 * resolved to a name; unknown ids are cached as misses so a follower that
 * vanished from the site does not re-list on every request.
 */
async function cachedGroupNames(
  session: TableauSession,
  groupIds: string[],
  dependencies: SubscriptionDependencies,
): Promise<Map<string, string>> {
  const now = Date.now();
  const resolved = new Map<string, string>();
  const missing: string[] = [];
  for (const id of groupIds) {
    const key = nameCacheKey(session, "GROUP", id);
    const cached = nameCache.get(key);
    if (cached && cached.expiresAt > now) {
      touch(nameCache, key, cached);
      if (cached.name) resolved.set(id, cached.name);
    } else {
      missing.push(id);
    }
  }
  if (missing.length > 0) {
    const groups = await dependencies.listGroups(session);
    const byId = new Map(groups.map((group) => [group.id, group.name]));
    for (const id of missing) {
      const name = byId.get(id) ?? null;
      nameCache.set(nameCacheKey(session, "GROUP", id), {
        name,
        expiresAt: now + NAME_CACHE_TTL_MS,
      });
      if (name) resolved.set(id, name);
    }
    evictNameCache();
  }
  return resolved;
}

function nameCacheKey(
  session: TableauSession,
  type: "USER" | "GROUP",
  id: string,
): string {
  return `${session.serverUrl}\u0000${session.siteId}\u0000${type}\u0000${id}`;
}

function evictNameCache(): void {
  while (nameCache.size > MAX_NAME_CACHE_ENTRIES) {
    const oldest = nameCache.keys().next().value as string | undefined;
    if (!oldest) break;
    nameCache.delete(oldest);
  }
}

export type FollowTargetInventory = PulseFollowTargets;

/**
 * Merge the full site group and user inventory into a single follow-target list.
 * REST API 3.27 rejects server-side `name:has:` filtering (400065), so there is
 * no `search` here: the picker loads the whole inventory once and filters
 * locally. Both listings are exhaustive - the whole directory is always returned
 * so every group and user is selectable.
 */
export async function getFollowTargets(
  session: TableauSession,
  dependencies: SubscriptionDependencies = defaultDependencies,
): Promise<FollowTargetInventory> {
  const errors: string[] = [];
  const [groupsResult, usersResult] = await Promise.allSettled([
    dependencies.listGroups(session),
    dependencies.listUsers(session),
  ]);

  let groups: Array<{ id: string; name: string }> = [];
  if (groupsResult.status === "fulfilled") {
    groups = groupsResult.value;
  } else {
    rethrowIfAuth(groupsResult.reason);
    errors.push(
      `Group inventory unavailable: ${diagnosticMessage(boundedProviderDiagnostic(groupsResult.reason))}`,
    );
  }

  let users: Array<{ id: string; name: string }> = [];
  if (usersResult.status === "fulfilled") {
    users = usersResult.value;
  } else {
    rethrowIfAuth(usersResult.reason);
    errors.push(
      `User inventory unavailable: ${diagnosticMessage(boundedProviderDiagnostic(usersResult.reason))}`,
    );
  }

  return { targets: buildFollowTargets(groups, users), errors };
}

function rethrowIfAuth(error: unknown): void {
  if (error instanceof TableauError && error.kind === "auth") throw error;
}

export function clearSubscriptionCaches(): void {
  nameCache.clear();
}
