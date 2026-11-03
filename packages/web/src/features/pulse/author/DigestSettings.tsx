import { PULSE_TEXT_LIMITS } from "@pulse-metric-studio/shared";
import { activeEditor, useAuthor } from "./controller";
import { useConnection } from "../connections/controller";
import { useId } from "react";

export function DigestSettings() {
  const entry = useAuthor(activeEditor);
  const { session, accessChecking, refreshAccess } = useConnection();
  const accessId = useId();
  if (!entry) return null;
  const { followMode, digestAudience, digestAudienceLocked } = entry.document;
  const groupAllowed = session?.groupCreation?.state === "allowed";
  const accessMessage = session?.groupCreation?.message ?? (session ? "Group creation permission is not verified." : "Connect to Tableau to verify group creation permission.");
  return (
    <section
      className="pulse-digest-settings"
      aria-label="Follow after publishing"
    >
      <span className="pulse-follow-label">Follow after publishing</span>
      <div className="pulse-follow-options" role="group" aria-label="Publication following">
        <button type="button" className="btn small" aria-pressed={followMode === "self"} onClick={() => useAuthor.getState().setFollowMode("self")}>Follow me</button>
        <button type="button" className="btn small" aria-pressed={followMode === "group"} disabled={!groupAllowed} aria-describedby={groupAllowed ? undefined : accessId} title={groupAllowed ? undefined : accessMessage} onClick={() => useAuthor.getState().setFollowMode("group")}>Digest group</button>
        <button type="button" className="btn small" aria-pressed={followMode === "none"} onClick={() => useAuthor.getState().setFollowMode("none")}>No follow</button>
      </div>
      <small className="section-hint">Follow me uses the connected Tableau account when you publish.</small>
      {!groupAllowed && <p id={accessId} className="section-hint pulse-follow-access" role="status">
        {accessMessage}{followMode === "group" && " Choose Follow me or No follow before publishing."}
        {session && <button type="button" className="btn small" disabled={accessChecking} onClick={() => void refreshAccess()}>{accessChecking ? "Checking permissions..." : "Check permissions"}</button>}
      </p>}
      {followMode === "group" && (
        <fieldset disabled={!groupAllowed} className="pulse-digest-audience">
          <label>
            Digest audience
            <input
              maxLength={PULSE_TEXT_LIMITS.audience}
              value={digestAudience}
              onChange={(event) =>
                useAuthor.getState().setAudience(event.target.value)
              }
            />
          </label>
          <button
            type="button"
            className="pulse-audience-lock"
            aria-label="Protect audience from assistant changes"
            aria-pressed={digestAudienceLocked}
            title={
              digestAudienceLocked
                ? "Audience protected from assistant changes"
                : "Allow assistant changes to audience"
            }
            onClick={() =>
              useAuthor.getState().setAudienceLocked(!digestAudienceLocked)
            }
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <path
                d={
                  digestAudienceLocked
                    ? "M5 9h10v8H5zM7 9V6a3 3 0 0 1 6 0v3"
                    : "M5 9h10v8H5zM7 9V6a3 3 0 0 1 6 0"
                }
              />
            </svg>
          </button>
        </fieldset>
      )}
    </section>
  );
}
