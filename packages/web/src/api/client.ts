import { desktopFetch } from "../desktop-transport";
import type { DatasourceCatalog } from "@pulse-metric-studio/shared";

/**
 * Pull a human-readable message out of an error response body. The server can
 * return `error` as a bare string OR as a structured object (e.g. an MQS
 * validation error). A prior version passed the raw value to `new Error(...)`,
 * so an object surfaced in the UI as the useless string "[object Object]".
 */
export function extractErrorMessage(data: unknown, status: number): string {
  const record =
    data && typeof data === "object" ? (data as Record<string, unknown>) : null;
  const err = record?.error;
  if (typeof err === "string" && err.trim()) return err;
  if (err && typeof err === "object") {
    const nested = (err as Record<string, unknown>).message;
    if (typeof nested === "string" && nested.trim()) return nested;
    try {
      return JSON.stringify(err);
    } catch {
      // fall through to the generic message
    }
  }
  if (typeof record?.message === "string" && record.message.trim())
    return record.message;
  return `Request failed (${status})`;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

async function req<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const resp = await desktopFetch(url, {
    method,
    headers:
      body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => null);
  if (!resp.ok) {
    throw new ApiError(extractErrorMessage(data, resp.status), resp.status);
  }
  return data as T;
}

// -- tableau ------------------------------------------------------------------

export interface TableauSessionInfo {
  connectionId: string;
  sessionGeneration: number;
  serverUrl: string;
  siteContentUrl: string;
  siteId: string;
  userId: string;
  userName?: string;
}

export interface ConnectionSummary {
  id: string;
  label: string;
  serverUrl: string;
  siteContentUrl: string;
  isActive: boolean;
}

export const api = {
  status: () =>
    req<{
      connected: boolean;
      restored?: boolean;
      hasStoredProfile?: boolean;
      session?: TableauSessionInfo;
    }>("/api/tableau/status"),
  disconnect: (owner: Pick<TableauSessionInfo, "connectionId" | "sessionGeneration">) =>
    req<{ ok: true }>("/api/tableau/disconnect", "POST", owner),
  connections: () =>
    req<{ connections: ConnectionSummary[] }>("/api/tableau/connections"),
  deleteConnection: (id: string) =>
    req<{ ok: true }>(`/api/tableau/connections/${id}`, "DELETE"),
  activateConnection: (id: string) =>
    req<{ ok: true }>(`/api/tableau/connections/${id}/activate`, "POST"),

  datasources: () =>
    req<{
      datasources: Array<{ luid: string; name: string; projectName: string }>;
    }>("/api/datasources"),
  fields: (luid: string, refresh = false) =>
    req<{ catalog: DatasourceCatalog }>(
      `/api/datasources/${encodeURIComponent(luid)}/fields${refresh ? "?refresh=1" : ""}`,
    ),
};
