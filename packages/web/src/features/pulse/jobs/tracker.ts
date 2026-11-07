import type { PulseMutationJobStatus } from "@pulse-metric-studio/shared";
import { errorMessage } from "../shell/notifications";
import type { SessionOwner } from "../shell/session-events";

/**
 * Progress of a running Tableau change across all of its requests, as the UI
 * shows it. `total` is null when the server has not reported a count yet.
 */
export interface MutationJobProgress {
  kind: PulseMutationJobStatus["kind"];
  total: number | null;
  completed: number;
  throttled: boolean;
  retryAt: number | null;
  serverTime: number;
  /** The server confirmed the job is stopping and sends nothing more. */
  stopping: boolean;
  /** Cancel was pressed and the server has not confirmed it yet. */
  cancelling: boolean;
  /** Why the last Cancel was not confirmed; the job may still be sending. */
  cancelError: string | null;
  stopReason: PulseMutationJobStatus["stopReason"];
}

/** Asks the server to stop a job; resolves only with its confirmation. */
export type CancelMutationJob = (id: string, owner: SessionOwner | null) => Promise<PulseMutationJobStatus>;

export interface MutationJobRunOptions {
  /** The session that started the change; Cancel is sent as this owner. */
  owner: SessionOwner | null;
  /** The item count to show, when the caller knows it better than one request does. */
  total: number | null;
  /** The view that started the change is still showing; progress is written only while it is. */
  current(): boolean;
  read(): MutationJobProgress | null;
  write(job: MutationJobProgress | null): void;
}

export interface MutationJobRun {
  /** Reports a status the running request returned. */
  observe(status: PulseMutationJobStatus): void;
  /** Moves progress past a finished request of `count` items. */
  advance(count: number): void;
  /** Cancel was pressed, or a request reported its job stopped; later requests are not sent. */
  readonly cancelled: boolean;
  /** Why the server stopped a request's job; null unless the server reported a stop. */
  readonly stopReason: PulseMutationJobStatus["stopReason"];
  /** Stops tracking: the change finished, so its progress goes away. */
  end(): void;
}

/**
 * Tracks the Tableau change a view is running, so its progress shows and
 * Cancel reaches it. One tracker follows one change at a time.
 */
export interface MutationJobTracker {
  begin(options: MutationJobRunOptions): MutationJobRun;
  /** Stops sending the running change; completed changes stay done. */
  cancel(): Promise<void>;
}

/**
 * Creates a tracker. Each run's requests report progress through its observer,
 * offset by the items earlier requests already finished.
 *
 * Cancel is two separate guarantees. Pressing it keeps this client from
 * starting any later request at once. The server job already running stops
 * only when the server confirms the cancel; until then the UI says it is
 * cancelling, and a failed cancel is shown and can be pressed again. A
 * Cancel pressed while the next request has not reported its job yet is
 * sent as soon as that job reports in.
 */
export function createMutationJobTracker(cancelJob: CancelMutationJob): MutationJobTracker {
  let active: { cancel(): Promise<void> } | null = null;
  return {
    begin({ owner, total, current, read, write }) {
      let id: string | null = null;
      let before = 0;
      let stopReason: PulseMutationJobStatus["stopReason"] = null;
      let requested = false;
      let confirmed = false;
      let sending = false;
      let awaitingId = false;
      const publish = (patch: Partial<MutationJobProgress>) => {
        const job = read();
        if (job && current() && active === handle) write({ ...job, ...patch });
      };
      const sendCancel = async (jobId: string) => {
        sending = true;
        awaitingId = false;
        publish({ cancelling: true, cancelError: null });
        try {
          const status = await cancelJob(jobId, owner);
          // A job that had already finished has nothing left to stop.
          confirmed = status.state === "stopping";
          stopReason = stopReason ?? status.stopReason;
          publish(confirmed ? { cancelling: false, stopping: true, stopReason } : { cancelling: false });
        } catch (error) {
          publish({
            cancelling: false,
            cancelError: `Cancel was not confirmed, so the batch may still be sending changes. ${errorMessage(error)}`,
          });
        } finally {
          sending = false;
        }
      };
      const handle = {
        async cancel() {
          if (confirmed || sending || awaitingId) return;
          requested = true;
          if (id) return sendCancel(id);
          awaitingId = true;
          publish({ cancelling: true, cancelError: null });
        },
      };
      active = handle;
      return {
        observe(status) {
          id = status.id;
          stopReason = stopReason ?? status.stopReason;
          if (status.state === "stopping") confirmed = true;
          if (awaitingId) void sendCancel(status.id);
          if (!current() || active !== handle) return;
          const previous = read();
          write({
            kind: status.kind,
            total: total ?? status.total,
            completed: before + status.completed,
            throttled: status.throttled || Boolean(previous?.throttled),
            retryAt: status.retryAt,
            serverTime: status.serverTime,
            stopping: confirmed,
            cancelling: sending || awaitingId,
            cancelError: previous?.cancelError ?? null,
            stopReason: stopReason ?? previous?.stopReason ?? null,
          });
        },
        advance(count) { before += count; id = null; },
        get cancelled() { return requested || stopReason !== null; },
        get stopReason() { return stopReason; },
        end() {
          if (active === handle) active = null;
          if (current()) write(null);
        },
      };
    },
    async cancel() {
      await active?.cancel();
    },
  };
}

/**
 * What a stopped change reports: `subject` names it, and `outcome` says what
 * stays done and what was not sent.
 */
export function stoppedMessage(reason: PulseMutationJobStatus["stopReason"], subject: string, outcome: string): string {
  return reason === "time_limit"
    ? `${subject} stopped after 2 hours. ${outcome}`
    : `${subject} was cancelled. ${outcome}`;
}
