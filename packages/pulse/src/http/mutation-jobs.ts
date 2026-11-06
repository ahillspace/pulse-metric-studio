import { randomUUID } from "node:crypto";
import {
  getTableauThrottleStatus,
  runTableauMutationJob,
  TABLEAU_MUTATION_JOB_LIMIT_MS,
  type TableauMutationStopReason,
  type TableauSession,
} from "@pulse-metric-studio/core";
import type { PulseMutationJobStatus } from "@pulse-metric-studio/shared";
import type { FastifyReply } from "fastify";

/** The HTTP answer a bulk change gives once it finishes. */
export interface MutationJobResponse { status: number; body: unknown }

type Outcome = { response: MutationJobResponse } | { error: unknown };

interface MutationJob {
  readonly id: string;
  readonly kind: PulseMutationJobStatus["kind"];
  readonly session: TableauSession;
  readonly controller: AbortController;
  total: number | null;
  completed: number;
  throttled: boolean;
  outcome?: Outcome;
  readonly finished: Promise<void>;
}

/**
 * How long a start request waits for its job before answering with a status
 * the client polls. A job that finishes sooner answers inline, exactly as a
 * plain request would. A throttled job answers at once so its progress shows.
 */
export const MUTATION_JOB_INLINE_WAIT_MS = 10_000;
/** How long a finished job keeps its response for a client that is still polling. */
export const MUTATION_JOB_RETENTION_MS = 10 * 60_000;

const jobs = new Map<string, MutationJob>();

function status(job: MutationJob): PulseMutationJobStatus {
  const throttle = getTableauThrottleStatus(job.session);
  const reason = job.controller.signal.reason as TableauMutationStopReason | undefined;
  return {
    id: job.id,
    kind: job.kind,
    state: job.outcome ? "finished" : job.controller.signal.aborted ? "stopping" : "running",
    total: job.total,
    completed: job.total === null ? job.completed : Math.min(job.completed, job.total),
    throttled: job.throttled,
    retryAt: job.throttled && throttle.throttled ? throttle.retryAt : null,
    serverTime: throttle.serverTime,
    stopReason: job.controller.signal.aborted ? (reason === "time_limit" ? "time_limit" : "cancelled") : null,
  };
}

function replay(reply: FastifyReply, outcome: Outcome): unknown {
  if ("error" in outcome) throw outcome.error;
  return reply.code(outcome.response.status).send(outcome.response.body);
}

/**
 * Runs a bulk Tableau change as a server-side job. Its writes wait out every
 * Tableau throttle, so the job has no overall time cap beyond a two-hour
 * anomaly limit that stops it exactly as Cancel would. The job continues if
 * the client stops polling; it ends with the app.
 */
export async function runMutationJob(
  reply: FastifyReply,
  kind: PulseMutationJobStatus["kind"],
  session: TableauSession,
  work: () => Promise<MutationJobResponse>,
  /** Turns a failure the route formats itself into its response; others reach the app's error handler. */
  formatError: (error: unknown) => MutationJobResponse | undefined = () => undefined,
): Promise<unknown> {
  const controller = new AbortController();
  let markThrottled!: () => void;
  const throttledSignal = new Promise<void>((resolve) => { markThrottled = resolve; });
  let settle!: () => void;
  const job: MutationJob = {
    id: randomUUID(), kind, session, controller, total: null, completed: 0, throttled: false,
    finished: new Promise<void>((resolve) => { settle = resolve; }),
  };
  jobs.set(job.id, job);
  const limit = setTimeout(() => controller.abort("time_limit"), TABLEAU_MUTATION_JOB_LIMIT_MS);
  limit.unref?.();
  void runTableauMutationJob({
    signal: controller.signal,
    throttled: () => { job.throttled = true; markThrottled(); },
    total: (count) => { job.total = Math.max(0, Math.floor(count)); },
    completed: (count) => { job.completed += Math.max(0, Math.floor(count)); },
  }, work).then(
    (response) => { job.outcome = { response }; },
    (error: unknown) => {
      const response = formatError(error);
      job.outcome = response ? { response } : { error };
    },
  ).finally(() => {
    clearTimeout(limit);
    settle();
    const expiry = setTimeout(() => { jobs.delete(job.id); }, MUTATION_JOB_RETENTION_MS);
    expiry.unref?.();
  });

  let wait: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    job.finished,
    throttledSignal,
    new Promise<void>((resolve) => { wait = setTimeout(resolve, MUTATION_JOB_INLINE_WAIT_MS); wait.unref?.(); }),
  ]);
  clearTimeout(wait);
  if (job.outcome) {
    jobs.delete(job.id);
    return replay(reply, job.outcome);
  }
  return reply.code(202).send({ job: status(job) });
}

function ownedJob(session: TableauSession, id: string): MutationJob | undefined {
  const job = jobs.get(id);
  return job && job.session === session ? job : undefined;
}

/** A running job's status, or its final response once it has finished. */
export function readMutationJob(reply: FastifyReply, session: TableauSession, id: string): unknown {
  const job = ownedJob(session, id);
  if (!job) return reply.code(404).send({ code: "job_not_found", message: "This batch is no longer running. Refresh metrics to see its results." });
  if (job.outcome) return replay(reply, job.outcome);
  return reply.code(202).send({ job: status(job) });
}

/**
 * Stops sending a job's remaining writes. Completed writes stay done, writes
 * Tableau is already processing finish, and the rest are reported as not sent.
 * The answer is the job's status, so the client knows the stop took effect;
 * the request waiting on the job still receives its final response.
 */
export function cancelMutationJob(reply: FastifyReply, session: TableauSession, id: string): unknown {
  const job = ownedJob(session, id);
  if (!job) return reply.code(404).send({ code: "job_not_found", message: "This batch is no longer running. Refresh metrics to see its results." });
  if (!job.outcome && !job.controller.signal.aborted) job.controller.abort("cancelled");
  return reply.code(200).send({ job: status(job) });
}
