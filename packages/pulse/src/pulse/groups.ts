import type { TableauSession } from '@pulse-metric-studio/core';
import { TableauError, apiPath, getJson } from '@pulse-metric-studio/core';
import { isPastEndError } from '@pulse-metric-studio/core';

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
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export async function ensureGroup(session: TableauSession, groupName: string): Promise<GroupInfo> {
  const safeName = groupName.trim().replace(/[^A-Za-z0-9 _-]/g, '').slice(0, 80);
  if (!safeName) throw new Error('Group name is empty after sanitization');

  // Pulse groups endpoint is authoritative when available
  try {
    const data = await getJson<any>(session, '/api/-/groups');
    const groups = (data?.groups ?? []) as any[];
    const match = groups.find((g) => typeof g?.name === 'string' && g.name.toLowerCase() === safeName.toLowerCase());
    if (match?.id) return { id: String(match.id), name: String(match.name), existedBefore: true };
  } catch (e) {
    if (e instanceof TableauError && e.kind === 'auth') throw e;
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
        apiPath(session, `/sites/${encodeURIComponent(session.siteId)}/groups?pageSize=${pageSize}&pageNumber=${pageNumber}`),
      );
    } catch (e) {
      if (isPastEndError(e)) break;
      throw e;
    }
    const groupsRaw = data?.groups?.group ?? data?.group;
    const groups = Array.isArray(groupsRaw) ? (groupsRaw as any[]) : [];
    const match = groups.find((g) => typeof g?.name === 'string' && g.name.toLowerCase() === safeName.toLowerCase());
    if (match?.id) return { id: String(match.id), name: String(match.name), existedBefore: true };
    if (groups.length < pageSize) break;
    pageNumber++;
  }

  // Create via tsRequest XML
  const resp = await fetch(`${session.serverUrl}${apiPath(session, `/sites/${encodeURIComponent(session.siteId)}/groups`)}`, {
    method: 'POST',
    headers: {
      'X-Tableau-Auth': session.token,
      'Content-Type': 'text/xml',
      Accept: 'application/xml',
    },
    body: `<tsRequest><group name="${escapeXml(safeName)}" /></tsRequest>`,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await resp.text().catch(() => '');
  if (!resp.ok) {
    throw new Error(`Group create failed (${resp.status}): ${text.slice(0, 300)}`);
  }
  const id = extractId(text);
  if (!id) throw new Error('Group create succeeded but response missing id');
  return { id, name: safeName, existedBefore: false };
}

export async function addUserToGroup(session: TableauSession, groupId: string, userId: string): Promise<void> {
  const resp = await fetch(
    `${session.serverUrl}${apiPath(session, `/sites/${encodeURIComponent(session.siteId)}/groups/${encodeURIComponent(groupId)}/users`)}`,
    {
      method: 'POST',
      headers: {
        'X-Tableau-Auth': session.token,
        'Content-Type': 'text/xml',
        Accept: 'application/xml',
      },
      body: `<tsRequest><user id="${escapeXml(userId)}" /></tsRequest>`,
      signal: AbortSignal.timeout(20_000),
    },
  ).catch((e) => {
    throw new Error(`Add user to group failed: ${e.message}`);
  });
  if (resp.ok || resp.status === 409) return; // 409 = already a member
  const text = await resp.text().catch(() => '');
  throw new Error(`Add user to group failed (${resp.status}): ${text.slice(0, 200)}`);
}

function extractId(xml: string): string | null {
  const m = xml.match(/<group[^>]*\sid="([^"]+)"/i);
  return m ? m[1] : null;
}
