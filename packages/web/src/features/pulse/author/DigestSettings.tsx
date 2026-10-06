import { PULSE_TEXT_LIMITS } from "@pulse-metric-studio/shared";
import { activeEditor, useAuthor } from "./controller";

export function DigestSettings() {
  const entry = useAuthor(activeEditor);
  if (!entry) return null;
  const { groupFollow, digestAudience, digestAudienceLocked } = entry.document;
  return (
    <section
      className="pulse-digest-settings"
      aria-label="Digest group settings"
    >
      <label className="pulse-native-checkbox">
        <input
          type="checkbox"
          checked={groupFollow}
          onChange={(event) =>
            useAuthor.getState().setGroupFollow(event.target.checked)
          }
        />
        Create or follow a digest group
      </label>
      {groupFollow && (
        <div className="pulse-digest-audience">
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
        </div>
      )}
    </section>
  );
}
