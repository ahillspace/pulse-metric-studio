import {
  PulseDraftRecordSchema,
  TableauThrottleMetadataSchema,
  type TableauThrottleMetadata,
  PulseDraftPageSchema,
  PulseReceiptPageSchema,
  type PulseListQuery,
  type PulseDraftListQuery,
  PulseAuthorProposalSchema,
  PulsePublishPlanSchema,
  PulsePublishReceiptSchema,
  PulseDeletePlanSchema,
  PulseDeleteResultSchema,
  type CreatePulseDraftRequest,
  type SavePulseDraftRequest,
  type PublishPulseDraftRequest,
  type PreparePulseDeleteRequest,
  type ExecutePulseDeleteRequest,
  type PulseWorkspaceDocumentV1,
} from "@pulse-metric-studio/shared";
import { captureSessionOwner, notifySessionExpired } from "../shell/session-events";
import { desktopFetch } from "../../../desktop-transport";
import { mutationJobRequest, type MutationJobObserver } from "./mutation-jobs";

export class PulseApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly details?: unknown,
    public readonly throttle?: TableauThrottleMetadata,
  ) {
    super(message);
    this.name = "PulseApiError";
  }
}

export async function pulseRequest(
  url: string,
  method = "GET",
  body?: unknown,
): Promise<unknown> {
  const owner = captureSessionOwner();
  const response = await desktopFetch(url, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401) notifySessionExpired(owner);
    throw pulseResponseError(response.status, data);
  }
  return data;
}

/** The error a failed Pulse API answer carries. */
export function pulseResponseError(status: number, data: unknown): PulseApiError {
  const record =
    data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const error =
    record.error && typeof record.error === "object"
      ? (record.error as Record<string, unknown>)
      : {};
  const message =
    typeof error.message === "string"
      ? error.message
      : typeof record.error === "string"
        ? record.error
        : typeof record.message === "string"
          ? record.message
          : `Request failed (${status})`;
  return new PulseApiError(
    message,
    status,
    typeof error.code === "string"
      ? error.code
      : typeof record.code === "string"
        ? record.code
        : undefined,
    error.details ?? record.details,
    TableauThrottleMetadataSchema.safeParse(record.throttle).success ? TableauThrottleMetadataSchema.parse(record.throttle) : undefined,
  );
}

function listUrl(
  resource: string,
  query: Partial<PulseDraftListQuery> = {},
): string {
  const params = new URLSearchParams({
    offset: String(query.offset ?? 0),
    limit: String(query.limit ?? 20),
  });
  if (query.q) params.set("q", query.q);
  for (const field of ["connectionId", "serverUrl", "siteId"] as const)
    if (query[field]) params.set(field, query[field]);
  return `/api/pulse/${resource}?${params}`;
}

export const pulseApi = {
  listDrafts: async (query: Partial<PulseDraftListQuery> = {}) =>
    PulseDraftPageSchema.parse(await pulseRequest(listUrl("drafts", query))),
  createDraft: async (input: CreatePulseDraftRequest) =>
    PulseDraftRecordSchema.parse(
      await pulseRequest("/api/pulse/drafts", "POST", input),
    ),
  readDraft: async (id: string) =>
    PulseDraftRecordSchema.parse(
      await pulseRequest(`/api/pulse/drafts/${encodeURIComponent(id)}`),
    ),
  saveDraft: async (id: string, input: SavePulseDraftRequest) =>
    PulseDraftRecordSchema.parse(
      await pulseRequest(
        `/api/pulse/drafts/${encodeURIComponent(id)}`,
        "PUT",
        input,
      ),
    ),
  deleteDraft: async (id: string, expectedRevision: number) => {
    await pulseRequest(
      `/api/pulse/drafts/${encodeURIComponent(id)}`,
      "DELETE",
      { expectedRevision },
    );
  },
  propose: async (
    id: string,
    baseRevision: number,
    message: string,
    document?: PulseWorkspaceDocumentV1,
  ) =>
    PulseAuthorProposalSchema.parse(
      await pulseRequest(
        `/api/pulse/drafts/${encodeURIComponent(id)}/proposals`,
        "POST",
        { baseRevision, message, document },
      ),
    ),
  preview: async (id: string, expectedRevision: number) =>
    PulsePublishPlanSchema.parse(
      await pulseRequest(
        `/api/pulse/drafts/${encodeURIComponent(id)}/publish-preview`,
        "POST",
        { expectedRevision },
      ),
    ),
  publish: async (id: string, input: PublishPulseDraftRequest) =>
    PulsePublishReceiptSchema.parse(
      await pulseRequest(
        `/api/pulse/drafts/${encodeURIComponent(id)}/publish`,
        "POST",
        input,
      ),
    ),
  listReceipts: async (query: Partial<PulseListQuery> = {}) =>
    PulseReceiptPageSchema.parse(
      await pulseRequest(listUrl("receipts", query)),
    ),
  readReceipt: async (id: string) =>
    PulsePublishReceiptSchema.parse(
      await pulseRequest(`/api/pulse/receipts/${encodeURIComponent(id)}`),
    ),
  undo: async (id: string) =>
    PulsePublishReceiptSchema.parse(
      await pulseRequest(
        `/api/pulse/receipts/${encodeURIComponent(id)}/undo`,
        "POST",
        {},
      ),
    ),
  deletePublicationGroup: async (id: string, groupId: string) =>
    PulsePublishReceiptSchema.parse(await pulseRequest(
      `/api/pulse/receipts/${encodeURIComponent(id)}/delete-group`, "POST", { groupId })),
  previewDelete: async (input: PreparePulseDeleteRequest) =>
    PulseDeletePlanSchema.parse(
      await pulseRequest("/api/pulse/registry/delete-preview", "POST", input),
    ),
  delete: async (input: ExecutePulseDeleteRequest, observe?: MutationJobObserver) => {
    const owner = captureSessionOwner();
    const result = await mutationJobRequest("/api/pulse/registry/delete", input, null, observe);
    if (!result.ok) {
      if (result.status === 401) notifySessionExpired(owner);
      throw pulseResponseError(result.status, result.data);
    }
    return PulseDeleteResultSchema.parse(result.data);
  },
};
export type PulseApi = typeof pulseApi;
