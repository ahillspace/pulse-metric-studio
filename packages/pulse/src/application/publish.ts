import {
  getFieldCatalog,
  getJson,
  apiPath,
  invalidateFieldsCache,
  sanitizeProviderMessage,
  TableauError,
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
  createDefinition,
  deleteDefinition,
  resolveDefaultMetricId,
} from "../pulse/pulse-client.js";
import { requirePulseOwner } from "./context.js";
import { PulseApplicationError } from "./errors.js";
import { fingerprint } from "./fingerprint.js";
import { invalidatePulseDefinitionInventory } from "./inventory.js";

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
  deleteDefinition: typeof deleteDefinition;
  deleteGroup: typeof deleteGroup;
  currentUser(session: TableauSession): Promise<string>;
}
export async function currentPulseCatalog(
  session: TableauSession,
  datasourceLuid: string,
): Promise<DatasourceCatalog> {
  invalidateFieldsCache(datasourceLuid);
  return getFieldCatalog(session, datasourceLuid);
}
const defaultDependencies: PublishDependencies = {
  catalog: currentPulseCatalog,
  create: createDefinition,
  resolve: resolveDefaultMetricId,
  ensureGroup,
  addMember: addUserToGroup,
  subscribe: batchCreateGroupSubscriptions,
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

export function digestGroupName(
  datasourceName: string,
  audience: string,
): string {
  return `pmStudio - ${datasourceName} - ${audience}`;
}

function diagnostic(error: unknown): PulseDiagnostic {
  return {
    message: sanitizeProviderMessage(
      error instanceof Error ? error.message : String(error),
    ),
    ...(error instanceof TableauError ? { status: error.status } : {}),
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
    const catalog = await this.dependencies.catalog(
      session,
      draft.context.datasourceLuid,
    );
    requirePulseOwner(draft.context, session);
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
      serializerVersion: 1,
      context: draft.context,
      payloads,
      groupFollow: draft.document.groupFollow,
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
      groupFollow: draft.document.groupFollow,
      issues: uniqueIssues,
    };
    return { draft, session, payloads, plan };
  }
  async preview(draftId: string, revision: number): Promise<PulsePublishPlan> {
    return (await this.prepare(draftId, revision)).plan;
  }

  async publish(
    draftId: string,
    request: PublishPulseDraftRequest,
  ): Promise<PulsePublishReceipt> {
    const requestHash = fingerprint({
      draftId,
      expectedRevision: request.expectedRevision,
      previewFingerprint: request.previewFingerprint,
    });
    const existing = this.repository.findReceipt(request.commandId);
    if (existing) return this.duplicate(request.commandId, requestHash);
    const { draft, session, payloads, plan } = await this.prepare(
      draftId,
      request.expectedRevision,
    );
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
    const follow = emptyFollowReceipt(draft.document.groupFollow, items.length);
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
    let authenticationFailed = false;
    try {
      for (const item of items) {
        requirePulseOwner(draft.context, session);
        item.creationStatus = "unknown";
        this.repository.saveItem(request.commandId, item);
        let created: Awaited<ReturnType<typeof createDefinition>>;
        try {
          created = await this.dependencies.create(
            session,
            payloads[item.itemIndex]!,
          );
        } catch (error) {
          item.diagnostic = diagnostic(error);
          // Only definitive validation/auth/permission rejection establishes no creation.
          if (
            error instanceof TableauError &&
            [400, 401, 403, 422].includes(error.status)
          )
            item.creationStatus = "not_created";
          this.repository.saveItem(request.commandId, item);
          if (error instanceof TableauError && error.kind === "auth") {
            authenticationFailed = true;
            break;
          }
          continue;
        }
        if (!created.definitionId) {
          item.diagnostic = {
            message:
              "Tableau returned no definition identifier. Inspect Tableau before retrying this item.",
          };
          this.repository.saveItem(request.commandId, item);
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
          requirePulseOwner(draft.context, session);
          item.metricId = await this.dependencies.resolve(
            session,
            created.definitionId,
          );
          item.resolutionStatus = item.metricId ? "resolved" : "pending";
        } catch (error) {
          item.resolutionStatus = "failed";
          item.diagnostic = diagnostic(error);
          authenticationFailed =
            error instanceof TableauError && error.kind === "auth";
        }
        this.repository.saveItem(request.commandId, item);
        if (authenticationFailed) break;
      }
      if (
        !authenticationFailed &&
        follow.requested &&
        items.some((item) => item.creationStatus === "created")
      ) {
        requirePulseOwner(draft.context, session);
        const name = digestGroupName(
          draft.datasourceName,
          draft.document.digestAudience,
        );
        follow.group = { status: "unknown", name };
        this.repository.saveFollow(request.commandId, follow);
        let group: Awaited<ReturnType<typeof ensureGroup>> | null = null;
        try {
          group = await this.dependencies.ensureGroup(session, name);
        } catch (error) {
          follow.group = {
            status: "unknown",
            name,
            error: diagnostic(error).message,
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
          requirePulseOwner(draft.context, session);
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
            await this.dependencies.addMember(session, group.id, userId);
            follow.membership = { status: "created" };
          } catch (error) {
            authenticationFailed =
              error instanceof TableauError && error.kind === "auth";
            follow.membership = {
              status: membershipRequested ? "unknown" : "failed",
              error: diagnostic(error).message,
            };
          }
          this.repository.saveFollow(request.commandId, follow);
          for (const subscription of follow.subscriptions) {
            if (authenticationFailed) break;
            const item = items[subscription.itemIndex]!;
            if (!item.metricId) {
              subscription.status = "skipped";
              subscription.error = "No confirmed default metric is available.";
              this.repository.saveFollow(request.commandId, follow);
              continue;
            }
            requirePulseOwner(draft.context, session);
            subscription.metricId = item.metricId;
            subscription.status = "unknown";
            this.repository.saveFollow(request.commandId, follow);
            try {
              const [result] = await this.dependencies.subscribe(session, [
                { metricId: item.metricId, groupId: group.id },
              ]);
              subscription.status = result?.ok
                ? result.alreadyExists
                  ? "reused"
                  : "created"
                : "unknown";
              if (result?.error)
                subscription.error = sanitizeProviderMessage(result.error);
            } catch (error) {
              authenticationFailed =
                error instanceof TableauError && error.kind === "auth";
              subscription.error = diagnostic(error).message;
            }
            this.repository.saveFollow(request.commandId, follow);
          }
        }
      }
      this.repository.finish(request.commandId);
    } finally {
      activePublishRuns.delete(request.commandId);
    }
    return this.repository.getReceipt(request.commandId);
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
  async deleteCreatedGroup(
    id: string,
    approvedGroupId: string,
  ): Promise<PulsePublishReceipt> {
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
    const session = requirePulseOwner(receipt.context);
    if (activePublishRuns.has(id) || this.undoInFlight.has(id))
      throw new PulseApplicationError(
        "publication_busy",
        "Wait for the current operation to finish.",
        409,
      );
    if (group.deletion?.status === "deleted") return receipt;
    this.undoInFlight.add(id);
    try {
      // Persist uncertainty before sending the deletion. Reopening never replays it.
      group.deletion = { status: "unknown" };
      this.repository.saveFollow(id, receipt.follow);
      try {
        requirePulseOwner(receipt.context, session);
        await this.dependencies.deleteGroup(session, group.id);
        group.deletion = { status: "deleted" };
      } catch (error) {
        group.deletion =
          error instanceof TableauError && error.status === 404
            ? { status: "deleted" }
            : {
                status:
                  error instanceof TableauError &&
                  [400, 401, 403, 422].includes(error.status)
                    ? "failed"
                    : "unknown",
                message: diagnostic(error).message,
              };
      }
      this.repository.saveFollow(id, receipt.follow);
      return this.repository.getReceipt(id);
    } finally {
      this.undoInFlight.delete(id);
    }
  }
  async undo(id: string): Promise<PulsePublishReceipt> {
    const receipt = this.repository.getReceipt(id);
    if (!receipt.context)
      throw new PulseApplicationError(
        "receipt_owner_unknown",
        "This historical receipt has no verified owner and cannot authorize undo.",
        409,
      );
    const session = requirePulseOwner(receipt.context);
    if (activePublishRuns.has(id) || this.undoInFlight.has(id))
      throw new PulseApplicationError(
        "publication_busy",
        "Wait for the current operation to finish.",
        409,
      );
    this.undoInFlight.add(id);
    try {
      for (const item of receipt.items.filter(
        (item) =>
          item.creationStatus === "created" &&
          item.definitionId &&
          item.undoStatus !== "deleted",
      )) {
        requirePulseOwner(receipt.context, session);
        item.undoStatus = "unknown";
        this.repository.saveItem(id, item);
        try {
          await this.dependencies.deleteDefinition(session, item.definitionId!);
          item.undoStatus = "deleted";
          item.undoDiagnostic = null;
        } catch (error) {
          item.undoStatus =
            error instanceof TableauError && error.status === 404
              ? "deleted"
              : error instanceof TableauError &&
                  [400, 401, 403, 422].includes(error.status)
                ? "failed"
                : "unknown";
          item.undoDiagnostic =
            item.undoStatus === "deleted" ? null : diagnostic(error);
        }
        this.repository.saveItem(id, item);
        invalidatePulseDefinitionInventory(session);
      }
      return this.repository.getReceipt(id);
    } finally {
      this.undoInFlight.delete(id);
    }
  }
}
