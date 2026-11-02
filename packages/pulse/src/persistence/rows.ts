import type { PulsePublishItemReceipt } from '@pulse-metric-studio/shared';

export interface WorkspaceRow {
  id: string;
  connection_id: string;
  server_url: string;
  site_id: string;
  datasource_luid: string;
  datasource_name: string;
  schema_version: number;
  revision: number;
  document_json: string;
  updated_at: number;
}

export interface PublishRunRow {
  id: string;
  request_hash: string | null;
  connection_id: string;
  server_url: string | null;
  site_id: string | null;
  user_id: string | null;
  datasource_luid: string;
  datasource_name: string;
  created_at: number;
  finished_at: number | null;
  follow_receipt_json: string;
  digest_audience: string | null;
  site_content_url: string | null;
}

export interface PublishItemRow {
  run_id: string;
  item_index: number;
  name: string;
  definition_summary_json: string;
  definition_id: string | null;
  metric_id: string | null;
  creation_status: PulsePublishItemReceipt['creationStatus'];
  resolution_status: PulsePublishItemReceipt['resolutionStatus'];
  diagnostic_json: string | null;
  undo_status: PulsePublishItemReceipt['undoStatus'];
  undo_diagnostic_json: string | null;
}

export interface LegacyDraftRow {
  connection_id: string;
  server_url: string;
  site_id: string;
  datasource_luid: string;
  state_json: string;
  updated_at: number;
}
export interface LegacyRunRow {
  id: string;
  connection_id: string;
  server_url: string | null;
  site_id: string | null;
  datasource_luid: string;
  datasource_name: string;
  group_id: string | null;
  group_name: string | null;
  created_at: number;
  summary: string;
}
export interface LegacyItemRow {
  run_id: string;
  item_index: number;
  name: string;
  payload_json: string;
  definition_id: string | null;
  metric_id: string | null;
  creation_status: string;
  resolution_status: string | null;
  undo_status: string | null;
  error: string | null;
  undo_error: string | null;
}
