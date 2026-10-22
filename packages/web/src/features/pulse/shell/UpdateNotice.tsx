import { useEffect, useState } from "react";
import { nativeUpdates, shouldPrompt, subscribeUpdates, type UpdateEvents, type UpdateStatus } from "../../../desktop-updates";
import { Modal } from "../components/ui";

/** Offers a newer release: a prompt when one is found, then a rail button until it is installed. */
export function UpdateNotice({ events = nativeUpdates }: { events?: UpdateEvents }) {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [promptedVersion, setPromptedVersion] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => subscribeUpdates(setStatus, events), [events]);
  useEffect(() => {
    if (!shouldPrompt(status, promptedVersion)) return;
    setPromptedVersion(status!.availableVersion);
    setOpen(true);
  }, [status, promptedVersion]);
  if (!status?.availableVersion) return null;

  const apply = async () => {
    setApplying(true);
    setError(null);
    try {
      // The app closes through its usual close flow, which saves drafts first.
      await events.apply();
      setOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setApplying(false);
    }
  };

  return (
    <>
      <UpdateButton version={status.availableVersion} onClick={() => { setError(null); setOpen(true); }} />
      {open && (
        <UpdateDialog
          status={status}
          applying={applying}
          error={error}
          onLater={() => setOpen(false)}
          onUpdate={() => void apply()}
        />
      )}
    </>
  );
}

export function UpdateButton({ version, onClick }: { version: string; onClick(): void }) {
  return (
    <button
      className="pulse-update-button"
      type="button"
      title={`Update to version ${version}`}
      aria-label={`Update Pulse Metric Studio to version ${version}`}
      onClick={onClick}
    >
      <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M10 3v10M6 9l4 4 4-4M4 16h12" />
      </svg>
      <span>Update to {version}</span>
    </button>
  );
}

export function UpdateDialog(props: {
  status: UpdateStatus;
  applying: boolean;
  error: string | null;
  onLater(): void;
  onUpdate(): void;
}) {
  const { status } = props;
  return (
    <Modal
      title="Update available"
      onClose={props.applying ? undefined : props.onLater}
      actions={<>
        <button className="btn" disabled={props.applying} onClick={props.onLater}>Later</button>
        <button className="btn primary" disabled={props.applying} onClick={props.onUpdate}>
          {props.applying ? "Closing..." : "Update now"}
        </button>
      </>}
    >
      <p>Pulse Metric Studio {status.availableVersion} is available. You have {status.currentVersion}.</p>
      <p>Updating saves your drafts, closes the app, installs the new version, and opens it again. This usually takes under a minute.</p>
      {status.lastError && <p className="update-error">The last update did not finish: {status.lastError}</p>}
      {props.error && <p className="update-error" role="alert">{props.error}</p>}
    </Modal>
  );
}
