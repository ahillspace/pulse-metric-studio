import type { PulsePublishReceipt } from "@pulse-metric-studio/shared";
import { BusyLabel, Modal } from "../components/ui";
import { JobProgress } from "../jobs/JobProgress";
import type { MutationJobProgress } from "../jobs/tracker";

/** Metrics an undo would remove: created by this publication and not yet deleted. */
export function undoTargets(receipt: PulsePublishReceipt) {
  return receipt.items.filter(
    (item) => item.creationStatus === "created" && item.undoStatus !== "deleted",
  );
}

export function ConfirmUndo({
  receipt,
  busy,
  disabled,
  onCancel,
  onConfirm,
  job = null,
  onCancelJob = () => {},
}: {
  receipt: PulsePublishReceipt;
  busy: boolean;
  disabled: boolean;
  onCancel(): void;
  onConfirm(): void;
  /** The running undo, shown once Tableau limits it. */
  job?: MutationJobProgress | null;
  onCancelJob?(): void;
}) {
  const targets = undoTargets(receipt);
  return (
    <Modal
      title="Undo publication?"
      onClose={busy ? undefined : onCancel}
      actions={
        <>
          <button className="btn" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button className="btn danger" disabled={busy || disabled} onClick={onConfirm}>
            <BusyLabel busy={busy} idle="Undo publication" active="Undoing..." />
          </button>
        </>
      }
    >
      <p>
        Delete{" "}
        {targets.length === 1
          ? "the metric definition"
          : `the ${targets.length} metric definitions`}{" "}
        this publication created in {receipt.datasourceName}, including their
        metric variants and followers. Digest groups remain.
      </p>
      {targets.length > 0 && (
        <ul className="pulse-confirm-list">
          {targets.map((item) => (
            <li key={item.itemIndex}>{item.name}</li>
          ))}
        </ul>
      )}
      <p>This cannot be undone.</p>
      {busy && <JobProgress job={job} onCancel={onCancelJob} />}
    </Modal>
  );
}
