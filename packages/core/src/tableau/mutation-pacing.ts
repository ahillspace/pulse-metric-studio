import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Bulk Tableau writes go out in small blocks. Each block must finish before a
 * short pause, then the next block starts, so a long batch never reaches
 * Tableau as one burst.
 */
export const TABLEAU_MUTATION_BLOCK_SIZE = 5;
export const TABLEAU_MUTATION_BLOCK_PAUSE_MS = 250;

/**
 * Response deadline for one dispatched Tableau write. Tableau caps writes per
 * site per minute and answers the excess with a 429 whose Retry-After ends
 * with that minute.
 *
 * Outside a mutation job this is also the whole write's deadline, so a single
 * write may wait out one full window and then be resent. Inside a job the wait
 * for permission to send has no deadline; each dispatched attempt still gets
 * only this long to answer.
 */
export const TABLEAU_MUTATION_TIMEOUT_MS = 90_000;

/**
 * Anomaly guard for one mutation job, and its only overall limit. A job that
 * reaches it stops exactly as if it had been cancelled.
 */
export const TABLEAU_MUTATION_JOB_LIMIT_MS = 2 * 60 * 60 * 1000;

export type TableauMutationStopReason = 'cancelled' | 'time_limit';

/**
 * A bulk write running as a server-side job. Writes sent inside it wait out
 * every Tableau throttle and resend until they succeed, fail for another
 * reason, or the job stops. Stopping never aborts a dispatched write: it only
 * keeps queued and later writes from being sent.
 */
export interface TableauMutationJob {
  /** Aborts when the job stops; its reason is the error each unsent write reports. */
  readonly signal: AbortSignal;
  /** Tableau answered a request in this job with a 429. */
  throttled(): void;
  /** The number of items the job reports on. */
  total(count: number): void;
  /** Items whose outcome is now final. */
  completed(count: number): void;
}

const jobs = new AsyncLocalStorage<TableauMutationJob>();

/** Runs `work` as a mutation job; every Tableau request it makes belongs to the job. */
export function runTableauMutationJob<T>(job: TableauMutationJob, work: () => Promise<T>): Promise<T> {
  return jobs.run(job, work);
}

export function currentTableauMutationJob(): TableauMutationJob | undefined {
  return jobs.getStore();
}

/** Progress reports for the current job; outside a job they do nothing. */
export const tableauMutationProgress = {
  total(count: number): void { jobs.getStore()?.total(count); },
  completed(count = 1): void { if (count > 0) jobs.getStore()?.completed(count); },
};

/** Waits `ms`, or less when the current job stops first. */
function pause(ms: number): Promise<void> {
  const signal = jobs.getStore()?.signal;
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

/**
 * Runs `worker` over `items` in blocks of {@link TABLEAU_MUTATION_BLOCK_SIZE},
 * waiting for every write in a block and then pausing before the next block.
 * Results keep input order. A stopped job skips the pause, so its workers can
 * report their remaining items as unsent at once.
 */
export async function runPacedMutationBlocks<T, R>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let offset = 0; offset < items.length; offset += TABLEAU_MUTATION_BLOCK_SIZE) {
    if (offset > 0) await pause(TABLEAU_MUTATION_BLOCK_PAUSE_MS);
    results.push(...await Promise.all(
      items.slice(offset, offset + TABLEAU_MUTATION_BLOCK_SIZE).map((item, index) => worker(item, offset + index)),
    ));
  }
  return results;
}

/**
 * Paces writes that must be sent one at a time: after every
 * {@link TABLEAU_MUTATION_BLOCK_SIZE} sends, the next send waits for the pause.
 */
export class TableauMutationPacer {
  private sent = 0;

  async send<T>(write: () => Promise<T>): Promise<T> {
    if (this.sent > 0 && this.sent % TABLEAU_MUTATION_BLOCK_SIZE === 0) await pause(TABLEAU_MUTATION_BLOCK_PAUSE_MS);
    this.sent++;
    return write();
  }
}
