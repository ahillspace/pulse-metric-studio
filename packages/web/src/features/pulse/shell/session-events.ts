import type { TableauSessionInfo } from "../../../api/client";

export type SessionOwner = Pick<TableauSessionInfo, "connectionId" | "sessionGeneration" | "serverUrl" | "siteId" | "userId">;
let activeOwner: SessionOwner | null = null;

export function sessionOwnerKey(owner: SessionOwner | null): string {
  return owner ? JSON.stringify([owner.connectionId, owner.sessionGeneration, owner.serverUrl, owner.siteId, owner.userId]) : "null";
}

export function setSessionOwner(owner: SessionOwner | null): void {
  activeOwner = owner ? {
    connectionId: owner.connectionId, sessionGeneration: owner.sessionGeneration,
    serverUrl: owner.serverUrl, siteId: owner.siteId, userId: owner.userId,
  } : null;
}

export function captureSessionOwner(): SessionOwner | null {
  return activeOwner ? { ...activeOwner } : null;
}

/** Query ownership crosses the native method/path/body transport without custom headers. */
export function ownedPulseUrl(url: string, owner: SessionOwner | null = captureSessionOwner()): string {
  if (!owner) return url;
  const expected = { connectionId: owner.connectionId, sessionGeneration: owner.sessionGeneration,
    serverUrl: owner.serverUrl, siteId: owner.siteId, userId: owner.userId };
  return `${url}${url.includes("?") ? "&" : "?"}expectedOwner=${encodeURIComponent(JSON.stringify(expected))}`;
}

/** A late rejection only notifies the owner that dispatched the request. */
export function notifySessionExpired(owner: SessionOwner | null): void {
  if (typeof window !== "undefined")
    window.dispatchEvent(new CustomEvent("pulse-session-expired", { detail: owner }));
}
