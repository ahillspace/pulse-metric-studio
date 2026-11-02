import type { TableauSession } from "@pulse-metric-studio/core";
import {
  TableauError,
  apiPath,
  classifyStatus,
  DEFAULT_MAX_RESPONSE_BYTES,
  getJson,
  readBoundedBody,
  parseTableauProviderError,
  safeTableauProviderCode,
  tableauFetch,
} from "@pulse-metric-studio/core";
import { listTableauGroups } from "./pulse-client.js";
import { captureMembershipInvalidation } from "./user-group-memberships.js";

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
    const data = await getJson<unknown>(session, "/api/-/groups");
    if (!data || typeof data !== 'object' || !('groups' in data) || !Array.isArray(data.groups))
      throw new Error('Unsupported Pulse groups response shape.');
    const groups = data.groups as Array<{ id?: unknown; name?: unknown }>;
    if (groups.some((group) => !group || typeof group !== 'object' || typeof group.id !== 'string' || !group.id.trim() || typeof group.name !== 'string' || !group.name.trim()))
      throw new Error('Unsupported Pulse groups record shape.');
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

  // A malformed directory is not evidence that the group is absent.
  const groups = await listTableauGroups(session);
  const match = groups.find((group) => group.name.toLowerCase() === safeName.toLowerCase());
  if (match) return { ...match, existedBefore: true };

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
      safeTableauProviderCode(resp.headers.get('validation_code'), [session.token]),
      parseTableauProviderError(text, [session.token]),
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
  const invalidate = captureMembershipInvalidation(session, userId);
  let response: Response | undefined;
  try {
    response = await tableauFetch(
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
    if (response.ok || response.status === 409) return; // 409 = already a member
    const text = await readBoundedBody(response, DEFAULT_MAX_RESPONSE_BYTES, 20_000).catch(() => "");
    throw new TableauError(
      `Add user to group failed (${response.status})`,
      response.status,
      text.slice(0, 200),
      classifyStatus(response.status, text),
      safeTableauProviderCode(response.headers.get('validation_code'), [session.token]),
      parseTableauProviderError(text, [session.token]),
    );
  } finally {
    if (!response || response.ok || response.status === 409 || response.status === 408 || response.status >= 500) invalidate();
  }
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
  const invalidate = captureMembershipInvalidation(session);
  let response: Response | undefined;
  try {
    response = await tableauFetch(
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
      safeTableauProviderCode(response.headers.get('validation_code'), [session.token]),
      parseTableauProviderError(body, [session.token]),
    );
  } finally {
    if (!response || response.ok || response.status === 404 || response.status === 408 || response.status >= 500) invalidate();
  }
}
