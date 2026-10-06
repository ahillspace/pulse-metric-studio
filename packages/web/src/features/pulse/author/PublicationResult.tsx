import { useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { PulsePublishReceipt } from "@pulse-metric-studio/shared";
import { contextMatches } from "./controller";
import { useConnection } from "../connections/controller";
import { useActivity } from "../activity/controller";
import { Modal } from "../components/ui";

export function pulseSiteUrl(serverUrl: string, siteContentUrl: string) {
  const url = new URL(serverUrl);
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error("Unsupported Tableau URL.");
  url.pathname = `/pulse/site/${encodeURIComponent(siteContentUrl)}`;
  url.search = "";
  url.hash = "";
  return url.href;
}

export function PublicationResult({ receipt, onClose, onActivity }: {
  receipt: PulsePublishReceipt;
  onClose: () => void;
  onActivity: () => void;
}) {
  const session = useConnection((state) => state.session);
  const activity = useActivity();
  const [confirmGroup, setConfirmGroup] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const connected = Boolean(receipt.context && contextMatches(receipt.context, session));
  const busy = activity.undoBusy || activity.groupBusy || receipt.publishing;
  const group = receipt.follow.group;
  const audience = receipt.digestAudience || "digest group";
  const contentUrl = receipt.siteContentUrl ?? (connected ? session?.siteContentUrl : undefined);
  const pulseUrl = receipt.context && contentUrl !== undefined ? pulseSiteUrl(receipt.context.serverUrl, contentUrl) : null;
  const canUndo = receipt.undoEligible || receipt.items.some((item) => item.undoStatus === "failed" || item.undoStatus === "unknown");
  const canDeleteGroup = group.status === "created" && Boolean(group.id) && group.deletion?.status !== "deleted";
  const failures = receipt.items.filter((item) => item.creationStatus !== "created");
  const followProblems = [group, receipt.follow.membership, ...receipt.follow.subscriptions].filter((item) => ['failed', 'unknown', 'not_attempted'].includes(item.status));
  const undone = receipt.items.filter((item) => item.undoStatus === "deleted").length;
  const errors = [linkError, activity.undoReceiptId === receipt.id ? activity.undoError : null, activity.groupReceiptId === receipt.id ? activity.groupError : null];
  if (confirmGroup) return <Modal title={`Delete "${audience}" group?`} onClose={busy ? undefined : () => setConfirmGroup(false)} actions={<>
    <button className="btn" disabled={busy} onClick={() => setConfirmGroup(false)}>Cancel</button>
    <button className="btn danger" disabled={busy || !connected} onClick={() => void activity.deleteGroup(receipt.id, group.id!).then(() => setConfirmGroup(false))}>{activity.groupBusy ? "Deleting..." : "Delete group"}</button>
  </>}><p>Delete this group, its memberships, and its subscriptions from Tableau. Metrics remain.</p><p>This cannot be undone.</p></Modal>;
  return <Modal title="Publication results" className="pulse-publication-result" onClose={busy ? undefined : onClose} actions={<>
    <button className="btn" disabled={!pulseUrl} onClick={() => {
      if (!pulseUrl) return;
      if (isTauri()) void openUrl(pulseUrl).catch((error: unknown) => setLinkError(error instanceof Error ? error.message : "Could not open Tableau Pulse."));
      else window.open(pulseUrl, "_blank", "noopener,noreferrer");
    }}>View in Pulse</button>
    <button className="btn" onClick={onActivity}>View in Activity</button>
    <button className="btn danger" disabled={!canUndo || !connected || busy} onClick={() => void activity.undo(receipt.id)}>{activity.undoBusy ? "Undoing..." : "Undo Publication"}</button>
    <button className="btn danger" disabled={!canDeleteGroup || !connected || busy} onClick={() => setConfirmGroup(true)}>{group.deletion?.status === "deleted" ? "Group deleted" : `Delete "${audience}" Group`}</button>
  </>}>
    <p className="pulse-result-total" role="status">{receipt.createdCount} {receipt.createdCount === 1 ? "metric created" : "metrics created"}</p>
    {undone > 0 && <p role="status">{undone} {undone === 1 ? "metric removed" : "metrics removed"} by undo.</p>}
    {receipt.items.filter((item) => item.undoStatus === "failed" || item.undoStatus === "unknown").map((item) => <p className="warning-banner" role="alert" key={`undo-${item.itemIndex}`}>
      <strong>{item.name}: </strong>{item.undoStatus === "unknown" ? "Undo is unconfirmed. " : "Undo failed. "}
      {item.undoDiagnostic?.code || item.undoDiagnostic?.status ? `${item.undoDiagnostic.code ?? item.undoDiagnostic.status}: ` : ""}{item.undoDiagnostic?.message}
      {item.undoStatus === "unknown" && " Check Tableau before retrying."}
    </p>)}
    {receipt.publishing && <p role="status">Publication is still in progress.</p>}
    {failures.length > 0 && <ul className="pulse-result-errors">{failures.map((item) => <li key={item.itemIndex}>
      <strong>{item.name}</strong><span>{item.creationStatus === "unknown" ? "Unconfirmed" : item.creationStatus === "not_attempted" ? "Not sent" : "Failed"}</span>
      <p>{item.diagnostic?.code || item.diagnostic?.status ? `${item.diagnostic.code ?? item.diagnostic.status}: ` : ""}{item.diagnostic?.message || (item.creationStatus === "unknown" ? "Check Tableau before retrying this metric." : item.creationStatus === "not_attempted" ? "This metric was not submitted." : "Tableau did not create this metric.")}</p>
    </li>)}</ul>}
    {receipt.items.some((item) => item.creationStatus === "created" && item.resolutionStatus !== "resolved" && item.undoStatus !== "deleted") && <p>Some created metrics are not yet visible in Tableau. See Activity for details.</p>}
    {receipt.items.filter((item) => item.creationStatus === "created" && item.resolutionStatus === "failed" && item.diagnostic && item.undoStatus !== "deleted").map((item) => <p className="warning-banner" key={`resolution-${item.itemIndex}`}><strong>{item.name}: </strong>{item.diagnostic!.code || item.diagnostic!.status ? `${item.diagnostic!.code ?? item.diagnostic!.status}: ` : ""}{item.diagnostic!.message}</p>)}
    {receipt.follow.requested && followProblems.length > 0 && <p className="warning-banner">Digest setup needs attention. {followProblems.find((item) => item.error)?.error || "See Activity for details."}</p>}
    {(group.deletion?.status === "failed" || group.deletion?.status === "unknown") && <p className="warning-banner" role="alert">
      {group.deletion.status === "unknown" ? "Group deletion is unconfirmed. " : "Group deletion failed. "}{group.deletion.message}
      {group.deletion.status === "unknown" && " Check Tableau before retrying."}
    </p>}
    {errors.filter(Boolean).map((error, index) => <p className="warning-banner" role="alert" key={index}>{error}</p>)}
  </Modal>;
}
