import { BusyLabel, Modal } from "../components/ui";
import { JobProgress } from "../jobs/JobProgress";
import type { MutationJobProgress } from "../jobs/tracker";

/** Confirms deleting the digest group a publication created. */
export function ConfirmGroupDeletion({
  name,
  busy,
  deleting,
  disabled,
  job = null,
  onCancelJob = () => {},
  onCancel,
  onConfirm,
}: {
  name: string;
  /** Any publication change is running, so this dialog cannot be dismissed. */
  busy: boolean;
  /** This group's deletion is the change that is running. */
  deleting: boolean;
  disabled: boolean;
  /** The running group deletion, shown once Tableau limits it. */
  job?: MutationJobProgress | null;
  onCancelJob?(): void;
  onCancel(): void;
  onConfirm(): void;
}) {
  return (
    <Modal
      title={`Delete "${name}" group?`}
      onClose={busy ? undefined : onCancel}
      actions={
        <>
          <button className="btn" disabled={busy} onClick={onCancel}>Cancel</button>
          <button className="btn danger" disabled={busy || disabled} onClick={onConfirm}>
            <BusyLabel busy={deleting} idle="Delete group" active="Deleting..." />
          </button>
        </>
      }
    >
      <p>Delete this group from Tableau, including its memberships and subscriptions. Metrics remain.</p>
      <p>This cannot be undone.</p>
      {deleting && <JobProgress job={job} onCancel={onCancelJob} />}
    </Modal>
  );
}
