import { randomUUID } from 'node:crypto';
import { getSessionContext, type TableauSession } from '@pulse-metric-studio/core';
import type { PulseDraftContext, PulseInventoryResponse } from '@pulse-metric-studio/shared';
import { requirePulseOwner } from './context.js';
import { PulseApplicationError } from './errors.js';
import { getExistingMetrics } from './inventory.js';

const MAX_SNAPSHOTS_PER_SESSION = 32;
interface InventorySnapshot {
  owner: PulseDraftContext;
  sessionContext: ReturnType<typeof getSessionContext>;
  userId: string;
  inventory: PulseInventoryResponse;
}
const snapshots = new WeakMap<TableauSession, Map<string, InventorySnapshot>>();

/** The connection comes from the authenticated session, never a renderer claim. */
export async function loadPulseInventory(
  session: TableauSession,
  datasourceLuid: string,
): Promise<PulseInventoryResponse> {
  const sessionContext = getSessionContext(session);
  const owner: PulseDraftContext = {
    connectionId: sessionContext?.connectionId ?? '',
    serverUrl: session.serverUrl,
    siteId: session.siteId,
    datasourceLuid,
  };
  requirePulseOwner(owner, session);
  const userId = session.userId;
  const result = await getExistingMetrics(session, datasourceLuid);
  requirePulseOwner(owner, session);
  if (getSessionContext(session) !== sessionContext || session.userId !== userId)
    throw refreshRequired();
  const inventory = { ...result, snapshotId: randomUUID() };
  const retained = snapshots.get(session) ?? new Map<string, InventorySnapshot>();
  retained.set(inventory.snapshotId, {
    owner: structuredClone(owner), sessionContext, userId,
    inventory: structuredClone(inventory),
  });
  while (retained.size > MAX_SNAPSHOTS_PER_SESSION)
    retained.delete(retained.keys().next().value!);
  snapshots.set(session, retained);
  return inventory;
}

/** Missing or stale snapshots never fall back to Tableau reads. */
export function getPulseInventorySnapshot(
  session: TableauSession,
  owner: PulseDraftContext,
  snapshotId: string,
): PulseInventoryResponse {
  requirePulseOwner(owner, session);
  const snapshot = snapshots.get(session)?.get(snapshotId);
  if (!snapshot || snapshot.sessionContext !== getSessionContext(session) ||
      snapshot.userId !== session.userId ||
      snapshot.owner.connectionId !== owner.connectionId ||
      snapshot.owner.serverUrl !== owner.serverUrl ||
      snapshot.owner.siteId !== owner.siteId ||
      snapshot.owner.datasourceLuid !== owner.datasourceLuid)
    throw refreshRequired();
  return structuredClone(snapshot.inventory);
}

function refreshRequired(): PulseApplicationError {
  return new PulseApplicationError(
    'delete_snapshot_unavailable',
    'The displayed inventory is no longer available for deletion. Refresh metrics and review the selection again.',
    409,
  );
}
