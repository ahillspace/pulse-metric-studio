import {
  getSession,
  getSessionContext,
  isSessionCurrent,
  type TableauSession,
} from '@pulse-metric-studio/core';
import type { PulseOwner } from '@pulse-metric-studio/shared';
import { PulseApplicationError } from './errors.js';

export function requirePulseOwner(
  owner: PulseOwner,
  session = getSession(),
): TableauSession {
  const context = session && getSessionContext(session);
  if (!session || !context || !isSessionCurrent(session))
    throw new PulseApplicationError(
      'tableau_connection_required',
      'Connect to the owning Tableau connection to continue.',
      401,
    );
  if (
    context.connectionId !== owner.connectionId ||
    context.serverUrl !== owner.serverUrl ||
    context.siteId !== owner.siteId
  )
    throw new PulseApplicationError(
      'tableau_context_changed',
      'The active Tableau connection does not own this work. Reconnect to its original connection.',
      409,
    );
  return session;
}
