import { useState } from "react";
import { createPortal } from "react-dom";
import type { PulsePublishReceipt } from "@pulse-metric-studio/shared";
import { contextMatches } from "../author/controller";
import { useConnection } from "../connections/controller";
import { BusyLabel, Modal } from "../components/ui";
import { useActivity } from "./controller";
import { ConfirmUndo } from "./ConfirmUndo";

export function ReceiptActions({ receipt }: { receipt: PulsePublishReceipt }) {
  const [confirmGroup, setConfirmGroup] = useState(false);
  const [confirmUndo, setConfirmUndo] = useState(false);
  const session = useConnection((state) => state.session);
  const { undoBusy, groupBusy, undoReceiptId, groupReceiptId, groupError } = useActivity();
  const group = receipt.follow.group;
  const canConnect = Boolean(receipt.context && contextMatches(receipt.context, session));
  const undoReason = !receipt.context
    ? "The original Tableau connection is unknown."
    : !canConnect ? "Connect to this publication's Tableau site to undo." : "";
  const showUndo = receipt.undoEligible || receipt.items.some(
    (item) => item.undoStatus === "failed" || item.undoStatus === "unknown",
  );
  const createdGroup = group.status === "created" && Boolean(group.id);
  const canDeleteGroup = createdGroup && group.deletion?.status !== "deleted";
  const busy = undoBusy || groupBusy || receipt.publishing;
  const undoingThisReceipt = undoBusy && undoReceiptId === receipt.id;

  return <>
    <div className="pulse-button-row pulse-receipt-actions">
      {showUndo && <button className="btn small danger"
        disabled={Boolean(undoReason) || busy}
        title="Delete the definitions created by this publication, including their metric variants. Digest groups remain."
        onClick={() => setConfirmUndo(true)}>
        <BusyLabel busy={undoingThisReceipt} idle="Undo publication" active="Undoing..." />
      </button>}
      {canDeleteGroup && <button className="btn small danger"
        disabled={!canConnect || busy} onClick={() => setConfirmGroup(true)}>
        <BusyLabel busy={groupBusy && groupReceiptId === receipt.id}
          idle={`Delete "${group.name || "Digest group"}" Group`} active="Deleting group..." />
      </button>}
    </div>
    {createdGroup && (group.deletion || (groupReceiptId === receipt.id && groupError)) && <div className="pulse-publication-group-action" aria-label="Publication digest group">
      {group.deletion?.status === "deleted" && <p role="status">Group deleted</p>}
      {group.deletion?.status === "unknown" && <p className="warning-banner">
        Group deletion is unconfirmed. Check Tableau before retrying.
      </p>}
      {group.deletion?.message && <p className="warning-banner">{group.deletion.message}</p>}
      {groupReceiptId === receipt.id && groupError && <p className="warning-banner" role="alert">{groupError}</p>}
    </div>}
    {showUndo && undoReason && <p className="pulse-receipt-note">{undoReason}</p>}
    {confirmGroup && createPortal(<Modal
      title={`Delete "${group.name || "Digest group"}" group?`}
      onClose={busy ? undefined : () => setConfirmGroup(false)}
      actions={<>
        <button className="btn" disabled={busy} onClick={() => setConfirmGroup(false)}>Cancel</button>
        <button className="btn danger" disabled={busy || !canConnect || !canDeleteGroup}
          onClick={() => {
            if (busy || !canConnect || !canDeleteGroup) return;
            void useActivity.getState().deleteGroup(receipt.id, group.id!)
              .then(() => setConfirmGroup(false));
          }}>
          <BusyLabel busy={groupBusy} idle="Delete group" active="Deleting..." />
        </button>
      </>}>
      <p>Delete this group from Tableau, including its memberships and subscriptions. Metrics remain.</p>
      <p>This cannot be undone.</p>
    </Modal>, document.body)}
    {confirmUndo && createPortal(<ConfirmUndo receipt={receipt} busy={undoingThisReceipt}
      disabled={Boolean(undoReason) || busy || !showUndo}
      onCancel={() => setConfirmUndo(false)}
      onConfirm={() => {
        if (undoReason || busy || !showUndo) return;
        void useActivity.getState().undo(receipt.id).then(() => setConfirmUndo(false));
      }} />, document.body)}
  </>;
}

export function SelectedReceiptActions({ receipt }: { receipt: PulsePublishReceipt | null }) {
  if (!receipt) return null;
  return <div className="pulse-history-selection-toolbar" role="group" aria-label="Selected publication actions">
    <div className="pulse-history-selection-context">
      <strong>{receipt.datasourceName}</strong>{" "}
      <time dateTime={new Date(receipt.createdAt).toISOString()}>{new Date(receipt.createdAt).toLocaleString()}</time>
    </div>
    <ReceiptActions key={receipt.id} receipt={receipt} />
  </div>;
}
