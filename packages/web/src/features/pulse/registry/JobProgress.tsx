import type { RegistryJob } from "./controller";

function localTime(job: RegistryJob): string | null {
  if (job.retryAt === null) return null;
  const at = new Date(Date.now() + Math.max(0, job.retryAt - job.serverTime));
  return at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Progress for a bulk change that Tableau is limiting. A batch Tableau never
 * limits finishes without showing this.
 */
export function JobProgress({ job, onCancel }: { job: RegistryJob | null; onCancel: () => void }) {
  if (!job?.throttled) return null;
  const done = job.total === null ? `${job.completed} done` : `${Math.min(job.completed, job.total)} of ${job.total} done`;
  const until = localTime(job);
  return (
    <div className="pulse-job-progress" role="status" aria-live="polite">
      {job.total !== null && job.total > 0 && (
        <progress max={job.total} value={Math.min(job.completed, job.total)} />
      )}
      <p>
        <strong>{done}.</strong>{" "}
        {job.stopping
          ? "Stopping: changes Tableau is already processing will finish, and the rest will not be sent."
          : until
            ? `Waiting for Tableau until ${until}. Tableau allows about 15 changes per minute on this site.`
            : "Sending the next changes."}
      </p>
      {job.cancelError && !job.stopping && <p role="alert">{job.cancelError}</p>}
      <button className="btn small" type="button" disabled={job.stopping || job.cancelling} onClick={onCancel}>
        {job.stopping ? "Stopping..." : job.cancelling ? "Cancelling..." : "Cancel remaining"}
      </button>
    </div>
  );
}
