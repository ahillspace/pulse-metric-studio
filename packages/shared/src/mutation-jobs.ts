import { z } from 'zod';

/**
 * A bulk Tableau change running on the server. A job answers its start request
 * directly when it finishes quickly; otherwise the client polls this status
 * until the job's final response is ready.
 */
export const PulseMutationJobStatusSchema = z.object({
  id: z.string().min(1).max(128),
  kind: z.enum(['delete', 'fork', 'follow', 'unfollow', 'publish', 'undo', 'group_delete']),
  /** `finished` appears only in a cancel answer for a job that had already ended. */
  state: z.enum(['running', 'stopping', 'finished']),
  total: z.number().int().nonnegative().nullable(),
  completed: z.number().int().nonnegative(),
  /** Tableau limited a request in this job, so the client shows progress and Cancel. */
  throttled: z.boolean(),
  /** When Tableau accepts more requests, while it is limiting them. */
  retryAt: z.number().int().nonnegative().nullable(),
  serverTime: z.number().int().nonnegative(),
  stopReason: z.enum(['cancelled', 'time_limit']).nullable(),
}).strict();
export type PulseMutationJobStatus = z.infer<typeof PulseMutationJobStatusSchema>;

export const PulseMutationJobAcceptedSchema = z.object({ job: PulseMutationJobStatusSchema }).strict();
