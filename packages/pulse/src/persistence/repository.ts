import { getDb, type Db } from "@pulse-metric-studio/core";
import {
  emptyPulseDocument,
  pulseReceiptHasUncertainty,
  PulseDraftRecordSchema,
  PulseDraftSummarySchema,
  PulseListQuerySchema,
  PulseDraftListQuerySchema,
  PulsePublishReceiptSchema,
  PulsePublishReceiptSummarySchema,
  PulseWorkspaceDocumentV1Schema,
  type CreatePulseDraftRequest,
  type PulseDraftContext,
  type PulseDraftPage,
  type PulseDraftRecord,
  type PulseFollowReceipt,
  type PulseListQuery,
  type PulseDraftListQuery,
  type PulsePublishItemReceipt,
  type PulsePublishReceipt,
  type PulseReceiptPage,
  type SavePulseDraftRequest,
} from "@pulse-metric-studio/shared";
import crypto from "node:crypto";
import { PulseApplicationError } from "../application/errors.js";
import "./migrations.js";
import type { PublishItemRow, PublishRunRow, WorkspaceRow } from "./rows.js";

export const activePublishRuns = new Set<string>();
function decodeDraft(row: WorkspaceRow): PulseDraftRecord {
  if (row.schema_version !== 1)
    throw new PulseApplicationError(
      "draft_schema_unsupported",
      "This draft requires a newer app.",
      409,
    );
  return PulseDraftRecordSchema.parse({
    id: row.id,
    context: {
      connectionId: row.connection_id,
      serverUrl: row.server_url,
      siteId: row.site_id,
      datasourceLuid: row.datasource_luid,
    },
    datasourceName: row.datasource_name,
    schemaVersion: 1,
    revision: row.revision,
    document: JSON.parse(row.document_json),
    updatedAt: row.updated_at,
  });
}

export class PulseRepository {
  constructor(private readonly database: () => Db = getDb) {
    this.database();
  }
  listDrafts(input: Partial<PulseDraftListQuery> = {}): PulseDraftPage {
    const { offset, limit, q, connectionId, serverUrl, siteId } =
      PulseDraftListQuerySchema.parse(input);
    const db = this.database();
    const search = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
    const where =
      "(datasource_name LIKE @search ESCAPE '\\' OR datasource_luid LIKE @search ESCAPE '\\' OR connection_id LIKE @search ESCAPE '\\') AND (@connectionId IS NULL OR connection_id=@connectionId) AND (@serverUrl IS NULL OR server_url=@serverUrl) AND (@siteId IS NULL OR site_id=@siteId)";
    const parameters = {
      search,
      connectionId: connectionId ?? null,
      serverUrl: serverUrl ?? null,
      siteId: siteId ?? null,
    };
    const { total } = db
      .prepare(`SELECT COUNT(*) AS total FROM pulse_workspaces WHERE ${where}`)
      .get(parameters) as { total: number };
    const rows = db
      .prepare(
        `SELECT id, connection_id, server_url, site_id, datasource_luid, datasource_name, schema_version, revision, updated_at FROM pulse_workspaces WHERE ${where} ORDER BY updated_at DESC, id LIMIT @limit OFFSET @offset`,
      )
      .all({ ...parameters, limit, offset }) as WorkspaceRow[];
    const drafts = rows.map((row) =>
      PulseDraftSummarySchema.parse({
        id: row.id,
        context: {
          connectionId: row.connection_id,
          serverUrl: row.server_url,
          siteId: row.site_id,
          datasourceLuid: row.datasource_luid,
        },
        datasourceName: row.datasource_name,
        schemaVersion: row.schema_version,
        revision: row.revision,
        updatedAt: row.updated_at,
      }),
    );
    return { drafts, total, offset, limit };
  }
  getDraft(id: string): PulseDraftRecord {
    const row = this.database()
      .prepare("SELECT * FROM pulse_workspaces WHERE id=?")
      .get(id) as WorkspaceRow | undefined;
    if (!row)
      throw new PulseApplicationError(
        "draft_not_found",
        "Saved draft not found.",
        404,
      );
    return decodeDraft(row);
  }
  createDraft(input: CreatePulseDraftRequest): PulseDraftRecord {
    const { connectionId, serverUrl, siteId, datasourceLuid } = input.context;
    const db = this.database();
    const old = db
      .prepare(
        "SELECT * FROM pulse_workspaces WHERE connection_id=? AND server_url=? AND site_id=? AND datasource_luid=?",
      )
      .get(connectionId, serverUrl, siteId, datasourceLuid) as
      WorkspaceRow | undefined;
    if (old) return decodeDraft(old);
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO pulse_workspaces VALUES(?,?,?,?,?,?,?,?,?,?)").run(
      id,
      connectionId,
      serverUrl,
      siteId,
      datasourceLuid,
      input.datasourceName,
      1,
      1,
      JSON.stringify(
        PulseWorkspaceDocumentV1Schema.parse(
          input.document ?? emptyPulseDocument(),
        ),
      ),
      Date.now(),
    );
    return this.getDraft(id);
  }
  saveDraft(id: string, input: SavePulseDraftRequest): PulseDraftRecord {
    const document = PulseWorkspaceDocumentV1Schema.parse(input.document);
    const result = this.database()
      .prepare(
        "UPDATE pulse_workspaces SET document_json=?, revision=revision+1, updated_at=? WHERE id=? AND revision=? AND schema_version=1",
      )
      .run(JSON.stringify(document), Date.now(), id, input.expectedRevision);
    if (!result.changes) this.revisionConflict(id);
    return this.getDraft(id);
  }
  deleteDraft(id: string, expectedRevision: number): void {
    if (
      !this.database()
        .prepare("DELETE FROM pulse_workspaces WHERE id=? AND revision=?")
        .run(id, expectedRevision).changes
    )
      this.revisionConflict(id);
  }
  private revisionConflict(id: string): never {
    const current = this.getDraft(id);
    throw new PulseApplicationError(
      "draft_revision_conflict",
      "This draft changed. Reload its latest revision before saving.",
      409,
      { currentRevision: current.revision },
    );
  }
  assertRevision(id: string, revision: number): PulseDraftRecord {
    const draft = this.getDraft(id);
    if (draft.revision !== revision) this.revisionConflict(id);
    return draft;
  }
  findReceipt(id: string): PulsePublishReceipt | null {
    const row = this.database()
      .prepare("SELECT * FROM pulse_publish_runs WHERE id=?")
      .get(id) as PublishRunRow | undefined;
    return row ? this.decodeReceipt(row) : null;
  }
  getReceipt(id: string): PulsePublishReceipt {
    const receipt = this.findReceipt(id);
    if (!receipt)
      throw new PulseApplicationError(
        "receipt_not_found",
        "Publication receipt not found.",
        404,
      );
    return receipt;
  }
  listReceipts(input: Partial<PulseListQuery> = {}): PulseReceiptPage {
    const { offset, limit, q } = PulseListQuerySchema.parse(input);
    const db = this.database();
    const search = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
    const where =
      "datasource_name LIKE @search ESCAPE '\\' OR datasource_luid LIKE @search ESCAPE '\\' OR connection_id LIKE @search ESCAPE '\\' OR id LIKE @search ESCAPE '\\'";
    const { total } = db
      .prepare(
        `SELECT COUNT(*) AS total FROM pulse_publish_runs WHERE ${where}`,
      )
      .get({ search }) as { total: number };
    type SummaryRow = Omit<PublishRunRow, "follow_receipt_json"> & {
      created_count: number;
      unknown_count: number;
      failed_count: number;
      unattempted_count: number;
      undo_count: number;
    };
    const rows = db
      .prepare(
        `
      WITH page AS (
        SELECT id, connection_id, server_url, site_id, datasource_luid, datasource_name, created_at, finished_at, digest_audience, site_content_url
        FROM pulse_publish_runs WHERE ${where}
        ORDER BY created_at DESC, id DESC LIMIT @limit OFFSET @offset
      )
      SELECT p.*,
        COALESCE(SUM(i.creation_status='created'),0) AS created_count,
        COALESCE(SUM(i.creation_status='unknown'),0) AS unknown_count,
        COALESCE(SUM(i.creation_status='not_created'),0) AS failed_count,
        COALESCE(SUM(i.creation_status='not_attempted'),0) AS unattempted_count,
        COALESCE(SUM(i.creation_status='created' AND (i.undo_status IS NULL OR i.undo_status<>'deleted')),0) AS undo_count
      FROM page p LEFT JOIN pulse_publish_items i ON i.run_id=p.id
      GROUP BY p.id ORDER BY p.created_at DESC, p.id DESC
    `,
      )
      .all({ search, limit, offset }) as SummaryRow[];
    const receipts = rows.map((row) => {
      const context =
        row.server_url && row.site_id
          ? {
              connectionId: row.connection_id,
              serverUrl: row.server_url,
              siteId: row.site_id,
              datasourceLuid: row.datasource_luid,
            }
          : null;
      const publishing = activePublishRuns.has(row.id);
      return PulsePublishReceiptSummarySchema.parse({
        id: row.id,
        context,
        connectionId: row.connection_id,
        datasourceLuid: row.datasource_luid,
        datasourceName: row.datasource_name,
        digestAudience: row.digest_audience ?? undefined,
        siteContentUrl: row.site_content_url ?? undefined,
        createdAt: row.created_at,
        finishedAt: row.finished_at,
        publishing,
        interrupted: !publishing && row.finished_at === null,
        createdCount: row.created_count,
        unknownCount: row.unknown_count,
        failedCount: row.failed_count,
        unattemptedCount: row.unattempted_count,
        undoEligible: Boolean(context) && !publishing && row.undo_count > 0,
      });
    });
    return { receipts, total, offset, limit };
  }
  requestHash(id: string): string | null {
    return (
      (
        this.database()
          .prepare("SELECT request_hash FROM pulse_publish_runs WHERE id=?")
          .get(id) as PublishRunRow | undefined
      )?.request_hash ?? null
    );
  }
  admit(input: {
    id: string;
    requestHash: string;
    context: PulseDraftContext;
    datasourceName: string;
    userId: string;
    digestAudience: string;
    siteContentUrl: string;
    items: PulsePublishItemReceipt[];
    follow: PulseFollowReceipt;
  }): void {
    const db = this.database();
    db.transaction(() => {
      db.prepare(
        `INSERT INTO pulse_publish_runs
          (id,request_hash,connection_id,server_url,site_id,user_id,datasource_luid,datasource_name,created_at,finished_at,follow_receipt_json,digest_audience,site_content_url)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        input.id,
        input.requestHash,
        input.context.connectionId,
        input.context.serverUrl,
        input.context.siteId,
        input.userId,
        input.context.datasourceLuid,
        input.datasourceName,
        Date.now(),
        null,
        JSON.stringify(input.follow),
        input.digestAudience,
        input.siteContentUrl,
      );
      const insert = db.prepare(
        "INSERT INTO pulse_publish_items VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      );
      for (const item of input.items)
        insert.run(
          input.id,
          item.itemIndex,
          item.name,
          JSON.stringify(item.summary),
          null,
          null,
          "not_attempted",
          null,
          null,
          null,
          null,
        );
    })();
  }
  saveItem(runId: string, item: PulsePublishItemReceipt): void {
    this.database()
      .prepare(
        "UPDATE pulse_publish_items SET definition_id=?,metric_id=?,creation_status=?,resolution_status=?,diagnostic_json=?,undo_status=?,undo_diagnostic_json=? WHERE run_id=? AND item_index=?",
      )
      .run(
        item.definitionId,
        item.metricId,
        item.creationStatus,
        item.resolutionStatus,
        item.diagnostic ? JSON.stringify(item.diagnostic) : null,
        item.undoStatus,
        item.undoDiagnostic ? JSON.stringify(item.undoDiagnostic) : null,
        runId,
        item.itemIndex,
      );
  }
  saveFollow(id: string, follow: PulseFollowReceipt): void {
    this.database()
      .prepare("UPDATE pulse_publish_runs SET follow_receipt_json=? WHERE id=?")
      .run(JSON.stringify(follow), id);
  }
  finish(id: string): void {
    this.database()
      .prepare("UPDATE pulse_publish_runs SET finished_at=? WHERE id=?")
      .run(Date.now(), id);
  }
  clearReceipt(id: string): void {
    const receipt = this.getReceipt(id);
    if (pulseReceiptHasUncertainty(receipt))
      throw new PulseApplicationError(
        "receipt_uncertain",
        "Keep this receipt until uncertain outcomes are resolved.",
        409,
      );
    this.database()
      .prepare("DELETE FROM pulse_publish_runs WHERE id=?")
      .run(id);
  }
  archives(): {
    archivedRuns: number;
    backup: string;
  } {
    const db = this.database();
    const count = (sql: string) =>
      (db.prepare(sql).get() as { count: number }).count;
    return {
      archivedRuns: count("SELECT COUNT(*) AS count FROM runs"),
      backup:
        "Original publication runs and run_metrics are retained as read-only recovery archives. Legacy Pulse drafts have been removed.",
    };
  }
  private decodeReceipt(row: PublishRunRow): PulsePublishReceipt {
    const items = (
      this.database()
        .prepare(
          "SELECT * FROM pulse_publish_items WHERE run_id=? ORDER BY item_index",
        )
        .all(row.id) as PublishItemRow[]
    ).map((item) => ({
      itemIndex: item.item_index,
      name: item.name,
      summary: JSON.parse(item.definition_summary_json),
      definitionId: item.definition_id,
      metricId: item.metric_id,
      creationStatus: item.creation_status,
      resolutionStatus: item.resolution_status,
      diagnostic: item.diagnostic_json
        ? JSON.parse(item.diagnostic_json)
        : null,
      undoStatus: item.undo_status,
      undoDiagnostic: item.undo_diagnostic_json
        ? JSON.parse(item.undo_diagnostic_json)
        : null,
    }));
    const context =
      row.server_url && row.site_id
        ? {
            connectionId: row.connection_id,
            serverUrl: row.server_url,
            siteId: row.site_id,
            datasourceLuid: row.datasource_luid,
          }
        : null;
    const publishing = activePublishRuns.has(row.id);
    return PulsePublishReceiptSchema.parse({
      id: row.id,
      context,
      connectionId: row.connection_id,
      datasourceLuid: row.datasource_luid,
      datasourceName: row.datasource_name,
      digestAudience: row.digest_audience ?? undefined,
      siteContentUrl: row.site_content_url ?? undefined,
      createdAt: row.created_at,
      finishedAt: row.finished_at,
      publishing,
      interrupted: !publishing && row.finished_at === null,
      items,
      follow: JSON.parse(row.follow_receipt_json),
      createdCount: items.filter((item) => item.creationStatus === "created")
        .length,
      unknownCount: items.filter((item) => item.creationStatus === "unknown")
        .length,
      failedCount: items.filter((item) => item.creationStatus === "not_created")
        .length,
      unattemptedCount: items.filter(
        (item) => item.creationStatus === "not_attempted",
      ).length,
      undoEligible:
        Boolean(context) &&
        !publishing &&
        items.some(
          (item) =>
            item.creationStatus === "created" && item.undoStatus !== "deleted",
        ),
    });
  }
}
