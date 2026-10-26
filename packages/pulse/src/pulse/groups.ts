import type { TableauSession } from "@pulse-metric-studio/core";
import {
  TableauError,
  apiPath,
  classifyStatus,
  DEFAULT_MAX_RESPONSE_BYTES,
  getJson,
  isPastEndError,
  readBoundedBody,
  tableauFetch,
} from "@pulse-metric-studio/core";

/**
 * Group ensure/lookup for the digest-follow flow.
 * Fixes ledger A1/A2: proper XML escaping + case-insensitive reuse detection.
 */

export interface GroupInfo {
  id: string;
  name: string;
  existedBefore: boolean;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export async function ensureGroup(
  session: TableauSession,
  groupName: string,
): Promise<GroupInfo> {
  if (!groupName.trim()) throw new Error("Group name is empty");
  const safeName = groupName;

  // Pulse groups endpoint is authoritative when available
  try {
    const data = await getJson<any>(session, "/api/-/groups");
    const groups = (data?.groups ?? []) as any[];
    const match = groups.find(
      (g) =>
        typeof g?.name === "string" &&
        g.name.toLowerCase() === safeName.toLowerCase(),
    );
    if (match?.id)
      return {
        id: String(match.id),
        name: String(match.name),
        existedBefore: true,
      };
  } catch (e) {
    if (e instanceof TableauError && e.kind === "auth") throw e;
    // fall through to REST search
  }

  // REST API fallback with paging
  const pageSize = 1000;
  let pageNumber = 1;
  for (;;) {
    let data: any;
    try {
      data = await getJson<any>(
        session,
        apiPath(
          session,
          `/sites/${encodeURIComponent(session.siteId)}/groups?pageSize=${pageSize}&pageNumber=${pageNumber}`,
        ),
      );
    } catch (e) {
      if (isPastEndError(e)) break;
      throw e;
    }
    const groupsRaw = data?.groups?.group ?? data?.group;
    const groups = Array.isArray(groupsRaw) ? (groupsRaw as any[]) : [];
    const match = groups.find(
      (g) =>
        typeof g?.name === "string" &&
        g.name.toLowerCase() === safeName.toLowerCase(),
    );
    if (match?.id)
      return {
        id: String(match.id),
        name: String(match.name),
        existedBefore: true,
      };
    if (groups.length < pageSize) break;
    pageNumber++;
  }

  // Create via tsRequest XML
  const resp = await tableauFetch(
    session,
    apiPath(session, `/sites/${encodeURIComponent(session.siteId)}/groups`),
    {
      method: "POST",
      headers: {
        "Content-Type": "text/xml",
        Accept: "application/xml",
      },
      body: `<tsRequest><group name="${escapeXml(safeName)}" /></tsRequest>`,
      timeoutMs: 20_000,
    },
  );
  const text = await readBoundedBody(resp, DEFAULT_MAX_RESPONSE_BYTES, 20_000).catch((error) => {
    if (resp.ok) throw error;
    return "";
  });
  if (!resp.ok) {
    throw new TableauError(
      `Group create failed (${resp.status})`,
      resp.status,
      text.slice(0, 300),
      classifyStatus(resp.status, text),
    );
  }
  const id = extractId(text);
  if (!id) throw new Error("Group create succeeded but response missing id");
  return { id, name: safeName, existedBefore: false };
}

export async function addUserToGroup(
  session: TableauSession,
  groupId: string,
  userId: string,
): Promise<void> {
  const resp = await tableauFetch(
    session,
    apiPath(
      session,
      `/sites/${encodeURIComponent(session.siteId)}/groups/${encodeURIComponent(groupId)}/users`,
    ),
    {
      method: "POST",
      headers: {
        "Content-Type": "text/xml",
        Accept: "application/xml",
      },
      body: `<tsRequest><user id="${escapeXml(userId)}" /></tsRequest>`,
      timeoutMs: 20_000,
    },
  );
  if (resp.ok || resp.status === 409) return; // 409 = already a member
  const text = await readBoundedBody(resp, DEFAULT_MAX_RESPONSE_BYTES, 20_000).catch(() => "");
  throw new TableauError(
    `Add user to group failed (${resp.status})`,
    resp.status,
    text.slice(0, 200),
    classifyStatus(resp.status, text),
  );
}

function extractId(xml: string): string | null {
  const m = xml.match(/<group[^>]*\sid="([^"]+)"/i);
  return m ? m[1] : null;
}

/** Delete the exact group ID recorded by a confirmed publication. */
export async function deleteGroup(
  session: TableauSession,
  groupId: string,
): Promise<void> {
  const response = await tableauFetch(
    session,
    apiPath(
      session,
      `/sites/${encodeURIComponent(session.siteId)}/groups/${encodeURIComponent(groupId)}`,
    ),
    { method: "DELETE", timeoutMs: 20_000 },
  );
  if (response.ok || response.status === 404) return;
  const body = await readBoundedBody(response, DEFAULT_MAX_RESPONSE_BYTES, 20_000).catch(() => "");
  throw new TableauError(
    `Group deletion failed (${response.status})`,
    response.status,
    body.slice(0, 300),
    classifyStatus(response.status, body),
  );
}
