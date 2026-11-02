import { getSessionContext, type TableauSession } from '@pulse-metric-studio/core';

const identities = new WeakMap<TableauSession, number>();
let nextIdentity = 0;

/** Isolates retained provider reads across activation, principal and session replacement. */
export function sessionCacheKey(session: TableauSession): string {
  let identity = identities.get(session);
  if (identity === undefined) { identity = ++nextIdentity; identities.set(session, identity); }
  const owner = getSessionContext(session);
  return JSON.stringify([identity, owner?.connectionId, owner?.generation, session.serverUrl, session.siteId, session.userId]);
}
