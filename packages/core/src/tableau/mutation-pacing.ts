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

/** Writes sent since the last pause, in one pacing sequence. */
interface PacingSequence { sinceLastPause: number }

interface RunningJob { readonly job: TableauMutationJob; readonly pacing: PacingSequence }

const jobs = new AsyncLocalStorage<RunningJob>();

/**
 * Runs `work` as a mutation job; every Tableau request it makes belongs to the job.
 * All of the job's writes share one pacing sequence, so a job that moves from one
 * kind of write to another (creates, then follows) still pauses after every block.
 */
export function runTableauMutationJob<T>(job: TableauMutationJob, work: () => Promise<T>): Promise<T> {
  return jobs.run({ job, pacing: { sinceLastPause: 0 } }, work);
}

export function currentTableauMutationJob(): TableauMutationJob | undefined {
  return jobs.getStore()?.job;
}

/** Progress reports for the current job; outside a job they do nothing. */
export const tableauMutationProgress = {
  total(count: number): void { jobs.getStore()?.job.total(count); },
  completed(count = 1): void { if (count > 0) jobs.getStore()?.job.completed(count); },
};

/** The current job's pacing sequence, or `own` for writes sent outside a job. */
function pacingSequence(own: () => PacingSequence): PacingSequence {
  return jobs.getStore()?.pacing ?? own();
}

/** Waits `ms`, or less when the current job stops first. */
function pause(ms: number): Promise<void> {
  const signal = jobs.getStore()?.job.signal;
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
 * Inside a job, a block that follows earlier writes of the job also waits for
 * the pause first. Results keep input order. A stopped job skips the pause, so
 * its workers can report their remaining items as unsent at once.
 */
export async function runPacedMutationBlocks<T, R>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const sequence = pacingSequence(() => ({ sinceLastPause: 0 }));
  const results: R[] = [];
  for (let offset = 0; offset < items.length; offset += TABLEAU_MUTATION_BLOCK_SIZE) {
    const block = items.slice(offset, offset + TABLEAU_MUTATION_BLOCK_SIZE);
    if (sequence.sinceLastPause > 0) await pause(TABLEAU_MUTATION_BLOCK_PAUSE_MS);
    sequence.sinceLastPause = block.length;
    results.push(...await Promise.all(block.map((item, index) => worker(item, offset + index))));
  }
  return results;
}

/**
 * Paces writes that must be sent one at a time: after every
 * {@link TABLEAU_MUTATION_BLOCK_SIZE} writes, the next one waits for the pause.
 * Inside a job every pacer continues the job's one sequence; outside a job each
 * pacer keeps its own.
 */
export class TableauMutationPacer {
  private own: PacingSequence | undefined;

  async send<T>(write: () => Promise<T>): Promise<T> {
    const sequence = pacingSequence(() => this.own ??= { sinceLastPause: 0 });
    if (sequence.sinceLastPause >= TABLEAU_MUTATION_BLOCK_SIZE) {
      await pause(TABLEAU_MUTATION_BLOCK_PAUSE_MS);
      sequence.sinceLastPause = 0;
    }
    sequence.sinceLastPause++;
    return write();
  }
}
