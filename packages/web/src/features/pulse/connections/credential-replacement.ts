import { canCompensateStagedCredential, type CredentialMutationResponse } from "../../../tableau-connections-api";
import { errorMessage } from "../shell/notifications";

export type CredentialRetirement = "removed" | "in_use" | "cleanup_failed";

/** Adopt committed ownership before attempting optional retirement of the prior secret. */
export async function settleCredentialReplacement(
  ticket: string | undefined,
  actions: {
    adopt: () => Promise<void>;
    retire: (ticket: string) => Promise<CredentialRetirement>;
  },
): Promise<CredentialRetirement | "none"> {
  await actions.adopt();
  if (!ticket) return "none";
  try {
    return await actions.retire(ticket);
  } catch {
    return "cleanup_failed";
  }
}
/** Run the same staged credential workflow used by the connection action. */
export async function replaceNativeCredential(actions: {
  store: () => Promise<string>;
  replace: (reference: string) => Promise<CredentialMutationResponse>;
  discard: (reference: string) => Promise<void>;
  clearSecret: () => void;
  remember: (ticket: string, connectionId: string) => void;
  adopt: (response: CredentialMutationResponse) => Promise<void>;
  retire: (ticket: string) => Promise<CredentialRetirement>;
}): Promise<{ ticket?: string; retirement: CredentialRetirement | "none" }> {
  let staged: string | null = null;
  let response: CredentialMutationResponse;
  try {
    staged = await actions.store();
    response = await actions.replace(staged);
  } catch (error) {
    if (staged && canCompensateStagedCredential(error)) {
      try { await actions.discard(staged); }
      catch { throw new Error(`${errorMessage(error)} The new OS credential could not be cleaned up.`); }
    }
    if (staged && !canCompensateStagedCredential(error)) actions.clearSecret();
    throw error;
  }
  const ticket = response.retirement?.ticket;
  if (ticket) actions.remember(ticket, response.connection.id);
  const retirement = await settleCredentialReplacement(ticket, {
    adopt: () => actions.adopt(response), retire: actions.retire,
  });
  return { ...(ticket ? { ticket } : {}), retirement };
}
