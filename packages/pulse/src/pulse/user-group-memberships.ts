import type { TableauSession } from '@pulse-metric-studio/core';
import { sessionCacheKey } from './session-cache-key.js';

type Memberships = Array<{ id: string; name: string }>;
interface Entry {
  owner: string;
  userId: string;
  expiresAt: number;
  request: Promise<Memberships>;
}
const memberships = new Map<string, Entry>();

export async function cachedUserGroupMemberships(
  session: TableauSession,
  userId: string,
  load: () => Promise<Memberships>,
): Promise<Memberships> {
  const owner = sessionCacheKey(session);
  const key = JSON.stringify([owner, userId]);
  const cached = memberships.get(key);
  if (cached && cached.expiresAt > Date.now()) return structuredClone(await cached.request);
  const entry = { owner, userId, expiresAt: Date.now() + 60_000, request: load() };
  memberships.delete(key);
  memberships.set(key, entry);
  while (memberships.size > 8) memberships.delete(memberships.keys().next().value!);
  try { return structuredClone(await entry.request); }
  catch (error) { if (memberships.get(key) === entry) memberships.delete(key); throw error; }
}

/** Capture before dispatch so an old mutation cannot invalidate a replacement session. */
export function captureMembershipInvalidation(session: TableauSession, userId?: string): () => void {
  const owner = sessionCacheKey(session);
  return () => {
    for (const [key, entry] of memberships) {
      if (entry.owner === owner && (userId === undefined || entry.userId === userId)) memberships.delete(key);
    }
  };
}

export function clearUserGroupMemberships(): void { memberships.clear(); }
