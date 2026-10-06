import { useState } from "react";
import { activeEditor, useAuthor } from "./controller";
import { Modal } from "../components/ui";

/** Persistence is automatic. Surface only failures that need a user action. */
export function WorkingStateNotice() {
  const entry = useAuthor(activeEditor);
  const error = useAuthor((state) => state.error);
  const [reload, setReload] = useState(false);
  if (!entry)
    return error ? (
      <p role="alert" className="warning-banner">
        {error}
      </p>
    ) : null;
  if (entry.saveStatus !== "error" && entry.saveStatus !== "conflict")
    return null;
  return (
    <>
      <div className="warning-banner" role="alert">
        <span>
          {entry.saveStatus === "conflict"
            ? "This configuration changed in another window. Your edits are still here."
            : "Changes could not be saved. Your edits are still here."}
        </span>
        {entry.saveStatus === "conflict" ? (
          <button className="btn small" onClick={() => setReload(true)}>
            Use saved version
          </button>
        ) : (
          <button
            className="btn small"
            onClick={() =>
              void useAuthor
                .getState()
                .flush()
                .catch(() => {})
            }
          >
            Retry save
          </button>
        )}
        {entry.saveError && (
          <details>
            <summary>Details</summary>
            {entry.saveError}
          </details>
        )}
      </div>
      {reload && (
        <Modal
          title="Replace your current edits?"
          onClose={() => setReload(false)}
          actions={
            <>
              <button className="btn" onClick={() => setReload(false)}>
                Keep editing
              </button>
              <button
                className="btn danger"
                onClick={() => {
                  void useAuthor.getState().openDraft(entry.record.id, true);
                  setReload(false);
                }}
              >
                Use saved version
              </button>
            </>
          }
        >
          <p>
            Your current edits will be replaced with the saved configuration.
          </p>
        </Modal>
      )}
    </>
  );
}
