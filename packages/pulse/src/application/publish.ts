import {
  getFieldCatalog,
  getJson,
  apiPath,
  sanitizeProviderMessage,
  TableauError,
  getGroupCreationAccess,
  getSessionContext,
  tableauMutationProgress,
  TableauMutationPacer,
  type TableauSession,
} from "@pulse-metric-studio/core";
import {
  reconcilePulseMetric,
  validatePulseDocument,
  type DatasourceCatalog,
  type PublishPulseDraftRequest,
  type PulseDefinitionSummary,
  type PulseDiagnostic,
  type PulseDraftRecord,
  type PulsePublishItemReceipt,
  type PulsePublishPlan,
  type PulsePublishReceipt,
  type PulseFollowReceipt,
  type PulseSelfRecipient,
} from "@pulse-metric-studio/shared";
import {
  buildCreatePayloads,
  validateSelection,
} from "../adapters/tableau/serializer.js";
import { emptyFollowReceipt } from "../persistence/migrations.js";
import {
  activePublishRuns,
  PulseRepository,
} from "../persistence/repository.js";
import { addUserToGroup, ensureGroup, deleteGroup } from "../pulse/groups.js";
import {
  batchCreateGroupSubscriptions,
  batchCreateUserSubscriptions,
  SubscriptionBatchInterrupted,
  type SubscriptionWriteResult,
  createDefinition,
  deleteDefinition,
  resolveDefaultMetricId,
} from "../pulse/pulse-client.js";
import { requirePulseOwner } from "./context.js";
import { PulseApplicationError } from "./errors.js";
import { fingerprint } from "./fingerprint.js";
import { invalidatePulseDefinitionInventory } from "./inventory.js";
import { pulseOperationDiagnostic, pulseOperationErrorMessage, type PulseOperation } from '../pulse/operation-errors.js';

export interface PublishDependencies {
  catalog(
    session: TableauSession,
    datasourceLuid: string,
  ): Promise<DatasourceCatalog>;
  create: typeof createDefinition;
  resolve: typeof resolveDefaultMetricId;
  ensureGroup: typeof ensureGroup;
  addMember: typeof addUserToGroup;
  subscribe: typeof batchCreateGroupSubscriptions;
  subscribeUser: typeof batchCreateUserSubscriptions;
  groupCreationAccess: typeof getGroupCreationAccess;
  deleteDefinition: typeof deleteDefinition;
  deleteGroup: typeof deleteGroup;
  currentUser(session: TableauSession): Promise<string>;
}
export async function currentPulseCatalog(
  session: TableauSession,
  datasourceLuid: string,
): Promise<DatasourceCatalog> {
  return getFieldCatalog(session, datasourceLuid, undefined, { refresh: true });
}
const defaultDependencies: PublishDependencies = {
  catalog: currentPulseCatalog,
  create: createDefinition,
  resolve: resolveDefaultMetricId,
  ensureGroup,
  addMember: addUserToGroup,
  subscribe: batchCreateGroupSubscriptions,
  subscribeUser: batchCreateUserSubscriptions,
  groupCreationAccess: getGroupCreationAccess,
  deleteDefinition,
  deleteGroup,
  currentUser: async (session) => {
    const result = await getJson<{ user?: { id?: string; luid?: string } }>(
      session,
      apiPath(session, "/users/current"),
    );
    return result.user?.id ?? result.user?.luid ?? "";
  },
};

/** A metric the publication never sent because it stopped first. */
export const PUBLICATION_STOPPED_METRIC = "Not sent: the publication stopped before this metric.";
/** A follow the publication never sent because it stopped first. */
export const PUBLICATION_STOPPED_FOLLOW = "Not sent: the publication stopped before this follow.";
/** A digest group step the publication never sent because it stopped first. */
export const PUBLICATION_STOPPED_STEP = "Not sent: the publication stopped before this step.";

/**
 * A publication operation after admission: a receipt that already answers it,
 * or the owning session and the run that sends its Tableau writes.
 */
export type PulsePublicationCommand =
  | { receipt: PulsePublishReceipt }
  | { session: TableauSession; run(): Promise<PulsePublishReceipt> };

function publishRequestHash(draftId: string, request: PublishPulseDraftRequest): string {
  return fingerprint({
    draftId,
    expectedRevision: request.expectedRevision,
    previewFingerprint: request.previewFingerprint,
  });
}

/** Tableau never received this write, so it has no effect to report or undo. */
function unsent(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "sent" in error && error.sent === false);
}

export function digestGroupName(
  datasourceName: string,
  audience: string,
): string {
  return `pmStudio - ${datasourceName} - ${audience}`;
}

function diagnostic(error: unknown, operation: PulseOperation = 'publish', session?: TableauSession): PulseDiagnostic {
  return {
    ...pulseOperationDiagnostic(error, operation, session ? [session.token] : []),
    ...(error instanceof PulseApplicationError ? { code: error.code } : {}),
  };
}
function definitionSummary(
  draft: PulseDraftRecord,
  catalog: DatasourceCatalog,
  fieldId: string,
): PulseDefinitionSummary {
  const metric = reconcilePulseMetric(
    catalog,
    draft.document.metrics[fieldId]!,
  );
  return {
    version: 1,
    fieldId: metric.fieldId,
    fieldLabel: metric.fieldLabel,
    aggregation: metric.aggregation,
    timeDimensionFieldId: metric.timeDimensionFieldId,
    timeDimensionLabel:
      catalog.timeDimensions.find(
        (field) => field.id === metric.timeDimensionFieldId,
      )?.label ?? "",
    temporality: metric.temporality,
    cumulative: metric.cumulative,
    slicers: Object.values(draft.document.slicers)
      .filter((slicer) => slicer.active)
      .map(({ fieldId, fieldLabel }) => ({ fieldId, fieldLabel })),
  };
}

export class PulsePublishService {
  private readonly dependencies: PublishDependencies;
  private readonly undoInFlight = new Set<string>();
  constructor(
    private readonly repository = new PulseRepository(),
    dependencies: Partial<PublishDependencies> = {},
  ) {
    this.dependencies = { ...defaultDependencies, ...dependencies };
  }

  private async prepare(draftId: string, revision: number) {
    const draft = this.repository.assertRevision(draftId, revision);
    const session = requirePulseOwner(draft.context);
    const capturedUserId = session.userId;
    const capturedContext = getSessionContext(session);
    const assertOwner = () => {
      requirePulseOwner(draft.context, session);
      if (session.userId !== capturedUserId || getSessionContext(session) !== capturedContext)
        throw new PulseApplicationError('tableau_context_changed', 'The Tableau account changed. Review this publication again.', 409);
    };
    const mode = draft.document.followMode;
    if (mode === 'self' && !capturedUserId?.trim())
      throw new PulseApplicationError('tableau_user_unavailable', 'Reconnect to Tableau to identify the account that will follow these metrics.', 401);
    const selfRecipient: PulseSelfRecipient | undefined = mode === 'self' ? { id: capturedUserId, ...(session.userName ? { name: session.userName } : {}) } : undefined;
    const catalog = await this.dependencies.catalog(
      session,
      draft.context.datasourceLuid,
    );
    assertOwner();
    const groupAccess = mode === 'group' ? this.dependencies.groupCreationAccess(session) : undefined;
    const assertGroupAccess = () => {
      assertOwner();
      if (mode !== 'group') return;
      const access = this.dependencies.groupCreationAccess(session);
      if (access.state !== 'allowed')
        throw new PulseApplicationError('tableau_group_creation_unavailable', access.message, access.state === 'denied' ? 403 : 409, { groupCreation: access });
    };
    this.repository.assertRevision(draftId, revision);
    if (catalog.datasourceLuid !== draft.context.datasourceLuid)
      throw new PulseApplicationError(
        "catalog_context_mismatch",
        "The returned catalog belongs to a different datasource.",
        409,
      );
    const metrics = Object.fromEntries(
      Object.entries(draft.document.metrics).map(([id, metric]) => [
        id,
        reconcilePulseMetric(catalog, metric),
      ]),
    );
    const input = { metrics, slicers: draft.document.slicers, catalog };
    const issues = [
      ...validatePulseDocument(draft.document, catalog),
      ...validateSelection(input),
      ...(groupAccess && groupAccess.state !== 'allowed' ? [{ field: 'followMode', message: groupAccess.message }] : []),
    ];
    const uniqueIssues = [
      ...new Map(
        issues.map((issue) => [`${issue.field}\0${issue.message}`, issue]),
      ).values(),
    ];
    const payloads = uniqueIssues.length ? [] : buildCreatePayloads(input);
    const summaries = Object.entries(draft.document.metrics)
      .filter(([, metric]) => metric.active)
      .map(([fieldId, metric]) => ({
        ...definitionSummary(draft, catalog, fieldId),
        name: metric.name,
        description: metric.description,
      }));
    const previewFingerprint = fingerprint({
      serializerVersion: 2,
      context: draft.context,
      payloads,
      followMode: mode,
      authenticatedOwner: { connectionId: capturedContext?.connectionId, serverUrl: session.serverUrl, siteId: session.siteId, userId: capturedUserId, sessionGeneration: capturedContext?.generation },
      selfTarget: selfRecipient?.id,
      audience: draft.document.digestAudience,
    });
    const plan: PulsePublishPlan = {
      draftId,
      revision,
      context: draft.context,
      datasourceName: draft.datasourceName,
      previewFingerprint,
      metrics: summaries,
      digestAudience: draft.document.digestAudience,
      followMode: mode,
      ...(selfRecipient ? { selfRecipient } : {}),
      issues: uniqueIssues,
    };
    return { draft, session, payloads, plan, assertGroupAccess, assertOwner };
  }
  async preview(draftId: string, revision: number): Promise<PulsePublishPlan> {
    return (await this.prepare(draftId, revision)).plan;
  }

  /**
   * Admits a publication. A repeated command answers with its receipt; a new
   * one needs its owning connection and runs as a Tableau mutation job.
   */
  publish(
    draftId: string,
    request: PublishPulseDraftRequest,
  ): PulsePublicationCommand {
    const requestHash = publishRequestHash(draftId, request);
    if (this.repository.findReceipt(request.commandId))
      return { receipt: this.duplicate(request.commandId, requestHash) };
    const session = requirePulseOwner(this.repository.getDraft(draftId).context);
    return { session, run: () => this.execute(draftId, request, requestHash) };
  }

  private async execute(
    draftId: string,
    request: PublishPulseDraftRequest,
    requestHash: string,
  ): Promise<PulsePublishReceipt> {
    const { draft, session, payloads, plan, assertGroupAccess, assertOwner } = await this.prepare(
      draftId,
      request.expectedRevision,
    );
    assertGroupAccess();
    if (plan.issues.length)
      throw new PulseApplicationError(
        "publish_validation_failed",
        "Correct the draft before publishing.",
        422,
        { issues: plan.issues },
      );
    if (request.previewFingerprint !== plan.previewFingerprint)
      throw new PulseApplicationError(
        "publish_preview_changed",
        "The reviewed publication changed. Review a new preview before publishing.",
        409,
      );
    // No await occurs between this second identity check and transactional admission.
    if (this.repository.findReceipt(request.commandId))
      return this.duplicate(request.commandId, requestHash);
    const items: PulsePublishItemReceipt[] = plan.metrics.map(
      ({ name, description: _description, ...summary }, itemIndex) => ({
        itemIndex,
        name,
        summary,
        definitionId: null,
        metricId: null,
        creationStatus: "not_attempted",
        resolutionStatus: null,
        diagnostic: null,
        undoStatus: null,
        undoDiagnostic: null,
      }),
    );
    const follow = emptyFollowReceipt(draft.document.followMode, items.length, plan.selfRecipient);
    // No await separates this current permission/owner check, admission, and the first write.
    assertGroupAccess();
    this.repository.admit({
      id: request.commandId,
      requestHash,
      context: draft.context,
      datasourceName: draft.datasourceName,
      userId: session.userId,
      digestAudience: plan.digestAudience,
      siteContentUrl: session.siteContentUrl,
      items,
      follow,
    });
    activePublishRuns.add(request.commandId);
    // The job reports one step per metric created and one per follow requested.
    tableauMutationProgress.total(items.length + follow.subscriptions.length);
    // Creates, the digest group, and its membership share one pacer, so they
    // reach Tableau as one paced sequence of writes.
    const pacer = new TableauMutationPacer();
    let authenticationFailed = false;
    // Set once a write was never sent: the publication sends nothing after it.
    let stopped = false;
    let subscriptionsSettled = false;
    try {
      for (const item of items) {
        if (stopped || authenticationFailed) {
          if (stopped) {
            item.diagnostic = { message: PUBLICATION_STOPPED_METRIC };
            this.repository.saveItem(request.commandId, item);
          }
          tableauMutationProgress.completed();
          continue;
        }
        assertOwner();
        item.creationStatus = "unknown";
        this.repository.saveItem(request.commandId, item);
        let created: Awaited<ReturnType<typeof createDefinition>>;
        try {
          created = await pacer.send(() => this.dependencies.create(
            session,
            payloads[item.itemIndex]!,
          ));
        } catch (error) {
          if (unsent(error)) {
            stopped = true;
            item.creationStatus = "not_attempted";
            item.diagnostic = { message: PUBLICATION_STOPPED_METRIC };
          } else {
            item.diagnostic = diagnostic(error, 'publish', session);
            // Only definitive validation/auth/permission rejection establishes no creation.
            if (
              error instanceof TableauError &&
              [400, 401, 403, 422].includes(error.status)
            )
              item.creationStatus = "not_created";
            authenticationFailed = error instanceof TableauError && error.kind === "auth";
          }
          this.repository.saveItem(request.commandId, item);
          tableauMutationProgress.completed();
          continue;
        }
        if (!created.definitionId) {
          item.diagnostic = {
            message:
              "Tableau returned no definition identifier. Inspect Tableau before retrying this item.",
          };
          this.repository.saveItem(request.commandId, item);
          tableauMutationProgress.completed();
          continue;
        }
        item.definitionId = created.definitionId;
        item.creationStatus = "created";
        item.resolutionStatus = "pending";
        item.undoStatus = "pending";
        // A persistence exception leaves the loop immediately, before optional remote effects.
        this.repository.saveItem(request.commandId, item);
        invalidatePulseDefinitionInventory(session);
        try {
          assertOwner();
          item.metricId = await this.dependencies.resolve(
            session,
            created.definitionId,
          );
          item.resolutionStatus = item.metricId ? "resolved" : "pending";
        } catch (error) {
          if (unsent(error)) {
            // The metric exists; the publication stopped before confirming it.
            stopped = true;
          } else {
            item.resolutionStatus = "failed";
            item.diagnostic = diagnostic(error, 'visibility', session);
            authenticationFailed =
              error instanceof TableauError && error.kind === "auth";
          }
        }
        this.repository.saveItem(request.commandId, item);
        tableauMutationProgress.completed();
      }
      if (
        !stopped &&
        !authenticationFailed &&
        follow.mode === 'group' &&
        items.some((item) => item.creationStatus === "created")
      ) {
        assertOwner();
        const name = digestGroupName(
          draft.datasourceName,
          draft.document.digestAudience,
        );
        follow.group = { status: "unknown", name };
        this.repository.saveFollow(request.commandId, follow);
        let group: Awaited<ReturnType<typeof ensureGroup>> | null = null;
        try {
          group = await pacer.send(() => this.dependencies.ensureGroup(session, name));
        } catch (error) {
          stopped = unsent(error);
          follow.group = {
            status: stopped ? "not_attempted" : "unknown",
            name,
            error: stopped ? PUBLICATION_STOPPED_STEP : pulseOperationErrorMessage(error, 'group', [session.token]),
          };
        }
        if (group)
          follow.group = {
            status: group.existedBefore ? "reused" : "created",
            id: group.id,
            name: group.name,
          };
        this.repository.saveFollow(request.commandId, follow);
        if (group) {
          assertOwner();
          follow.membership = { status: "unknown" };
          this.repository.saveFollow(request.commandId, follow);
          let membershipRequested = false;
          try {
            const userId =
              session.userId || (await this.dependencies.currentUser(session));
            if (!userId)
              throw new Error(
                "Publishing user could not be resolved. Group membership was not requested.",
              );
            membershipRequested = true;
            await pacer.send(() => this.dependencies.addMember(session, group.id, userId));
            follow.membership = { status: "created" };
          } catch (error) {
            stopped = unsent(error);
            authenticationFailed =
              error instanceof TableauError && error.kind === "auth";
            follow.membership = stopped
              ? { status: "not_attempted", error: PUBLICATION_STOPPED_STEP }
              : {
                  status: membershipRequested ? "unknown" : "failed",
                  error: pulseOperationErrorMessage(error, 'membership', [session.token]),
                };
          }
          this.repository.saveFollow(request.commandId, follow);
          if (!authenticationFailed && !stopped) {
            subscriptionsSettled = true;
            ({ authenticationFailed, stopped } = await this.subscribeConfirmedMetrics(session, request.commandId, follow, items, { kind: 'GROUP', id: group.id }, assertOwner));
          }
        }
      }
      if (!stopped && !authenticationFailed && follow.mode === 'self' && plan.selfRecipient && items.some((item) => item.creationStatus === 'created')) {
        subscriptionsSettled = true;
        ({ stopped } = await this.subscribeConfirmedMetrics(session, request.commandId, follow, items, { kind: 'USER', id: plan.selfRecipient.id }, assertOwner));
      }
      if (stopped) {
        for (const subscription of follow.subscriptions)
          if (subscription.status === 'not_attempted' && !subscription.error) subscription.error = PUBLICATION_STOPPED_FOLLOW;
        this.repository.saveFollow(request.commandId, follow);
      }
      if (!subscriptionsSettled) tableauMutationProgress.completed(follow.subscriptions.length);
      this.repository.finish(request.commandId);
    } finally {
      activePublishRuns.delete(request.commandId);
    }
    return this.repository.getReceipt(request.commandId);
  }

  /**
   * Follows every confirmed metric with one subscription batch. Each follow is
   * recorded as unknown before the batch is sent, then settled from its result.
   * The batch reports progress for the follows it sends; this reports the rest.
   */
  private async subscribeConfirmedMetrics(
    session: TableauSession,
    commandId: string,
    follow: PulseFollowReceipt,
    items: PulsePublishItemReceipt[],
    target: { kind: 'USER' | 'GROUP'; id: string },
    assertOwner: () => void,
  ): Promise<{ authenticationFailed: boolean; stopped: boolean }> {
    const pending: PulseFollowReceipt['subscriptions'] = [];
    for (const subscription of follow.subscriptions) {
      const item = items[subscription.itemIndex]!;
      if (item.creationStatus !== 'created' || !item.metricId) {
        subscription.status = 'skipped';
        subscription.error = item.resolutionStatus === 'failed' && item.diagnostic?.message
          ? `Default metric confirmation failed: ${item.diagnostic.message}`
          : 'No confirmed default metric is available.';
        tableauMutationProgress.completed();
        continue;
      }
      subscription.metricId = item.metricId;
      pending.push(subscription);
    }
    this.repository.saveFollow(commandId, follow);
    if (!pending.length) return { authenticationFailed: false, stopped: false };
    assertOwner();
    for (const subscription of pending) subscription.status = 'unknown';
    this.repository.saveFollow(commandId, follow);
    const settle = (subscription: PulseFollowReceipt['subscriptions'][number], result: SubscriptionWriteResult | undefined) => {
      subscription.status = result?.ok ? result.alreadyExists ? 'reused' : 'created' : result?.unknown ? 'unknown' : result ? 'failed' : 'unknown';
      if (result?.error) subscription.error = sanitizeProviderMessage(result.error);
    };
    try {
      const results = target.kind === 'USER'
        ? await this.dependencies.subscribeUser(session, pending.map((subscription) => ({ metricId: subscription.metricId!, userId: target.id })))
        : await this.dependencies.subscribe(session, pending.map((subscription) => ({ metricId: subscription.metricId!, groupId: target.id })));
      const byMetric = new Map(results.map((result) => [result.metricId, result]));
      for (const subscription of pending) settle(subscription, byMetric.get(subscription.metricId!));
      this.repository.saveFollow(commandId, follow);
      return { authenticationFailed: false, stopped: false };
    } catch (error) {
      const interrupted = error instanceof SubscriptionBatchInterrupted ? error : undefined;
      const completed = new Map((interrupted?.completed ?? []).map((result) => [result.metricId, result]));
      // A batch that did not interrupt itself reports nothing, so its follows all failed together.
      const failed = new Set(interrupted ? interrupted.failedTargets.map((entry) => entry.metricId) : pending.map((subscription) => subscription.metricId!));
      const confirmation = interrupted?.phase === 'confirmation';
      // A follow Tableau confirmed before a conflict check stopped was sent, even if the check was not.
      const notSent = !confirmation && unsent(error);
      const authenticationFailed = error instanceof TableauError && error.kind === 'auth';
      const message = pulseOperationErrorMessage(error, 'follow', [session.token]);
      for (const subscription of pending) {
        const result = completed.get(subscription.metricId!);
        if (result) settle(subscription, result);
        else if (failed.has(subscription.metricId!)) {
          subscription.status = notSent
            ? 'not_attempted'
            : error instanceof TableauError && !confirmation && (authenticationFailed || [400, 403, 404, 422].includes(error.status))
              ? 'failed'
              : 'unknown';
          subscription.error = message;
        } else {
          // The batch stops at its first interruption, so Tableau never received these.
          subscription.status = 'not_attempted';
          if (notSent) subscription.error = PUBLICATION_STOPPED_FOLLOW;
        }
      }
      this.repository.saveFollow(commandId, follow);
      tableauMutationProgress.completed(pending.length - (interrupted ? interrupted.completed.length : 0));
      return { authenticationFailed, stopped: notSent };
    }
  }
  private duplicate(id: string, hash: string): PulsePublishReceipt {
    if (this.repository.requestHash(id) !== hash)
      throw new PulseApplicationError(
        "publish_command_conflict",
        "This command ID belongs to a different publication request.",
        409,
      );
    return this.repository.getReceipt(id);
  }
  /** Claims a receipt for one operation, or refuses while another is running. */
  private claim(id: string): void {
    if (activePublishRuns.has(id) || this.undoInFlight.has(id))
      throw new PulseApplicationError(
        "publication_busy",
        "Wait for the current operation to finish.",
        409,
      );
    this.undoInFlight.add(id);
  }
  /**
   * Admits deleting the exact group a publication created. A group already
   * deleted answers with its receipt; otherwise the deletion runs as a job.
   */
  deleteCreatedGroup(
    id: string,
    approvedGroupId: string,
  ): PulsePublicationCommand {
    const receipt = this.repository.getReceipt(id);
    const group = receipt.follow.group;
    if (
      !receipt.context ||
      group.status !== "created" ||
      !group.id ||
      group.id !== approvedGroupId
    )
      throw new PulseApplicationError(
        "publication_group_not_owned",
        "Only the exact group created by this publication can be deleted.",
        409,
      );
    const context = receipt.context;
    const groupId = group.id;
    const session = requirePulseOwner(context);
    this.claim(id);
    if (group.deletion?.status === "deleted") {
      this.undoInFlight.delete(id);
      return { receipt };
    }
    return { session, run: async () => {
      try {
        tableauMutationProgress.total(1);
        const previous = group.deletion;
        // Persist uncertainty before sending the deletion. Reopening never replays it.
        group.deletion = { status: "unknown" };
        this.repository.saveFollow(id, receipt.follow);
        try {
          requirePulseOwner(context, session);
          await this.dependencies.deleteGroup(session, groupId);
          group.deletion = { status: "deleted" };
        } catch (error) {
          if (unsent(error)) {
            // Tableau never received it, so the earlier outcome still stands.
            if (previous) group.deletion = previous;
            else delete group.deletion;
          } else
            group.deletion =
              error instanceof TableauError && error.status === 404
                ? { status: "deleted" }
                : {
                    status:
                      error instanceof TableauError &&
                      [400, 401, 403, 422].includes(error.status)
                        ? "failed"
                        : "unknown",
                    message: pulseOperationErrorMessage(error, 'group-delete', [session.token]),
                  };
        }
        this.repository.saveFollow(id, receipt.follow);
        tableauMutationProgress.completed();
        return this.repository.getReceipt(id);
      } finally {
        this.undoInFlight.delete(id);
      }
    } };
  }
  /** Admits undoing a publication; its definition deletes run as a job. */
  undo(id: string): PulsePublicationCommand {
    const receipt = this.repository.getReceipt(id);
    if (!receipt.context)
      throw new PulseApplicationError(
        "receipt_owner_unknown",
        "This historical receipt has no verified owner and cannot authorize undo.",
        409,
      );
    const context = receipt.context;
    const session = requirePulseOwner(context);
    this.claim(id);
    return { session, run: async () => {
      try {
        const eligible = receipt.items.filter(
          (item) =>
            item.creationStatus === "created" &&
            item.definitionId &&
            item.undoStatus !== "deleted",
        );
        tableauMutationProgress.total(eligible.length);
        const pacer = new TableauMutationPacer();
        for (const item of eligible) {
          requirePulseOwner(context, session);
          const previous = { undoStatus: item.undoStatus, undoDiagnostic: item.undoDiagnostic };
          item.undoStatus = "unknown";
          this.repository.saveItem(id, item);
          try {
            await pacer.send(() => this.dependencies.deleteDefinition(session, item.definitionId!));
            item.undoStatus = "deleted";
            item.undoDiagnostic = null;
          } catch (error) {
            if (unsent(error)) {
              // Tableau never received it, and nothing after it is sent.
              Object.assign(item, previous);
              this.repository.saveItem(id, item);
              break;
            }
            item.undoStatus =
              error instanceof TableauError && error.status === 404
                ? "deleted"
                : error instanceof TableauError &&
                    [400, 401, 403, 422].includes(error.status)
                  ? "failed"
                  : "unknown";
            item.undoDiagnostic =
              item.undoStatus === "deleted" ? null : diagnostic(error, 'delete', session);
          }
          this.repository.saveItem(id, item);
          invalidatePulseDefinitionInventory(session);
          tableauMutationProgress.completed();
        }
        return this.repository.getReceipt(id);
      } finally {
        this.undoInFlight.delete(id);
      }
    } };
  }
}
