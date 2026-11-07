import type { MutationJobProgress } from "./tracker";

/**
 * Progress for a bulk change that Tableau is limiting. A batch Tableau never
 * limits finishes without showing this.
 *
 * The status names the state only. Tableau sets its write limits and resume
 * times server-side and can change them, so the app never quotes a rate or a
 * clock time.
 */
export function JobProgress({ job, onCancel }: { job: MutationJobProgress | null; onCancel: () => void }) {
  if (!job?.throttled) return null;
  const done = job.total === null ? `${job.completed} done` : `${Math.min(job.completed, job.total)} of ${job.total} done`;
  return (
    <div className="pulse-job-progress" role="status" aria-live="polite">
      {job.total !== null && job.total > 0 && (
        <progress max={job.total} value={Math.min(job.completed, job.total)} />
      )}
      <p>
        <strong>{done}.</strong>{" "}
        {job.stopping
          ? "Stopping: changes Tableau is already processing will finish, and the rest will not be sent."
          : job.retryAt !== null && job.retryAt > job.serverTime
            ? "Waiting for Tableau to accept more changes."
            : "Sending changes."}
      </p>
      {job.cancelError && !job.stopping && <p role="alert">{job.cancelError}</p>}
      <button className="btn small" type="button" disabled={job.stopping || job.cancelling} onClick={onCancel}>
        {job.stopping ? "Stopping..." : job.cancelling ? "Cancelling..." : "Cancel remaining"}
      </button>
    </div>
  );
}
