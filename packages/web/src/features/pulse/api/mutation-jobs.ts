import { PulseMutationJobAcceptedSchema, type PulseMutationJobStatus } from "@pulse-metric-studio/shared";
import { desktopFetch } from "../../../desktop-transport";
import { extractErrorMessage } from "../../../api/client";
import { notifySessionExpired, ownedPulseUrl, type SessionOwner } from "../shell/session-events";

/** Reports each status a running bulk change returns while the client waits for it. */
export type MutationJobObserver = (status: PulseMutationJobStatus) => void;

/** The final answer of a bulk change, exactly as a plain request would return it. */
export interface MutationJobResult { ok: boolean; status: number; data: unknown }

const POLL_INTERVAL_MS = 1000;
/** Consecutive failed status reads tolerated before the client stops waiting. */
const POLL_FAILURE_LIMIT = 5;

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function read(response: Response): Promise<MutationJobResult> {
  return { ok: response.ok, status: response.status, data: await response.json().catch(() => null) };
}

function acceptedJob(result: MutationJobResult): PulseMutationJobStatus | null {
  if (result.status !== 202) return null;
  const accepted = PulseMutationJobAcceptedSchema.safeParse(result.data);
  return accepted.success ? accepted.data.job : null;
}

/**
 * Sends a bulk Tableau change. A change that finishes quickly answers
 * directly. A longer one answers with a job, which this polls until the job's
 * final response is ready, reporting progress to `observe` along the way. The
 * job keeps running on the server between polls, so a failed status read is
 * retried before the client gives up waiting.
 */
export async function mutationJobRequest(
  path: string,
  body: unknown,
  owner: SessionOwner | null,
  observe?: MutationJobObserver,
): Promise<MutationJobResult> {
  let result = await read(await desktopFetch(ownedPulseUrl(path, owner), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
  let job = acceptedJob(result);
  let failures = 0;
  while (job) {
    observe?.(job);
    await pause(POLL_INTERVAL_MS);
    try {
      result = await read(await desktopFetch(ownedPulseUrl(`/api/pulse/jobs/${encodeURIComponent(job.id)}`, owner)));
      failures = 0;
    } catch (error) {
      if (++failures >= POLL_FAILURE_LIMIT) throw new Error(
        `Lost contact with the running batch. It may still be finishing; refresh metrics to see its results. ${error instanceof Error ? error.message : ""}`.trim(),
      );
      continue;
    }
    const next = acceptedJob(result);
    if (!next) break;
    job = next;
  }
  return result;
}

/**
 * Asks a running bulk change to stop and resolves with the server's
 * confirmation: the job is stopping, or it had already finished. Completed
 * changes stay done, changes Tableau is already processing finish, and the
 * rest are reported as not sent; the waiting request receives the final
 * response. Rejects when the server did not confirm, so the caller can say so
 * and let the user try again.
 */
export async function cancelMutationJob(id: string, owner: SessionOwner | null): Promise<PulseMutationJobStatus> {
  const result = await read(await desktopFetch(ownedPulseUrl(`/api/pulse/jobs/${encodeURIComponent(id)}/cancel`, owner), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  }));
  if (result.status === 401) notifySessionExpired(owner);
  const confirmed = result.ok ? PulseMutationJobAcceptedSchema.safeParse(result.data) : null;
  if (confirmed?.success && confirmed.data.job.state !== "running") return confirmed.data.job;
  throw new Error(result.ok ? "The server returned an invalid cancel confirmation." : extractErrorMessage(result.data, result.status));
}
