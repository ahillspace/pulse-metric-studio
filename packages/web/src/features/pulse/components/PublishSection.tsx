import { createPortal } from "react-dom";
import {
  activeEditor,
  contextMatches,
  previewIsStale,
  useAuthor,
} from "../author/controller";
import { useConnection } from "../connections/controller";
import { useActivity } from "../activity/controller";
import { PublicationResult } from "../author/PublicationResult";
import { BusyLabel, Modal } from "./ui";

export function PublishSection({
  onActivity,
  visible = true,
}: {
  onActivity: () => void;
  visible?: boolean;
}) {
  const entry = useAuthor(activeEditor);
  const session = useConnection((state) => state.session);
  const latestReceipt = useActivity((state) =>
    entry?.receipt ? state.receiptById[entry.receipt.id] : undefined,
  );
  if (!entry) return null;
  const connected = contextMatches(entry.record.context, session);
  const preview = entry.preview;
  const hasSelection =
    Object.values(entry.document.metrics).some((metric) => metric.active) &&
    Object.values(entry.document.slicers).some((slicer) => slicer.active);
  const stale = previewIsStale(entry);
  const receipt = latestReceipt ?? entry.receipt;
  return (
    <section
      className="pulse-publication-settings"
      id="publish-panel"
      aria-label="Publication settings"
    >
      <div className="panel-body">
        <div className="publish-bar">
          {visible &&
            document.getElementById("pulse-header-actions") &&
            createPortal(
              <button
                className="btn primary"
                disabled={
                  !connected ||
                  !hasSelection ||
                  entry.previewBusy ||
                  entry.publishBusy ||
                  entry.saveStatus === "conflict" ||
                  Boolean(entry.publishCommandId)
                }
                onClick={() => void useAuthor.getState().reviewPublication()}
                aria-label="Review publication"
                title={
                  !hasSelection
                    ? "Select at least one metric and one slicer to publish."
                    : undefined
                }
              >
                <BusyLabel busy={entry.previewBusy} idle="Publish" active="Preparing..." />
              </button>,
              document.getElementById("pulse-header-actions")!,
            )}
        </div>
        {!connected && (
          <p className="section-hint">Connect to Tableau to publish.</p>
        )}
        {entry.publishError && (
          <p className="warning-banner" role="alert">
            {entry.publishError}
          </p>
        )}
        {receipt && visible && (
          <PublicationResult
            key={receipt.id}
            receipt={receipt}
            onClose={() => useAuthor.getState().closeReceipt()}
            onActivity={() => { useAuthor.getState().closeReceipt(); onActivity(); }}
          />
        )}
      </div>
      {preview && (
        <Modal
          title="Review publication"
          onClose={
            entry.publishBusy || entry.publishCommandId
              ? undefined
              : () => useAuthor.getState().closePreview()
          }
          actions={
            <>
              {!entry.publishCommandId && (
                <button
                  className="btn"
                  disabled={entry.publishBusy}
                  onClick={() => useAuthor.getState().closePreview()}
                >
                  Cancel
                </button>
              )}
              <button
                className="btn primary"
                disabled={
                  (!connected && !entry.publishCommandId) ||
                  entry.publishBusy ||
                  (stale && !entry.publishCommandId) ||
                  preview.issues.length > 0 ||
                  preview.metrics.length === 0
                }
                onClick={() => void useAuthor.getState().publishReviewed()}
                aria-label={
                  entry.publishCommandId
                    ? "Check publication result"
                    : "Publish reviewed draft"
                }
              >
                <BusyLabel busy={entry.publishBusy} idle={entry.publishCommandId
                    ? "Check publication result"
                    : "Publish metrics"} active="Publishing..." />
              </button>
            </>
          }
        >
          <p>
            <strong>{preview.datasourceName}</strong>
          </p>
          <p className="section-hint">
            {new URL(preview.context.serverUrl).hostname}
          </p>
          <p>
            This creates {preview.metrics.length} metric{" "}
            {preview.metrics.length === 1 ? "definition" : "definitions"} in
            Tableau Pulse.
          </p>
          <ul className="result-list">
            {preview.metrics.map((metric, index) => (
              <li key={`${metric.fieldId}-${index}`}>
                <strong>{metric.name}</strong>
                <p>
                  {(
                    {
                      SUM: "Sum",
                      AVG: "Average",
                      MIN: "Minimum",
                      MAX: "Maximum",
                      COUNT: "Count",
                      COUNT_DISTINCT: "Distinct count",
                      MEDIAN: "Median",
                      USER: "Calculated value",
                    } as Record<string, string>
                  )[metric.aggregation] ?? metric.aggregation}{" "}
                  of {metric.fieldLabel} -{" "}
                  {metric.timeDimensionLabel || "Date field required"}
                  {metric.cumulative ? " - cumulative" : ""}
                </p>
                <p>
                  Slicers:{" "}
                  {metric.slicers.map((field) => field.fieldLabel).join(", ") ||
                    "None"}
                </p>
                {metric.description && <p>{metric.description}</p>}
              </li>
            ))}
          </ul>
          {preview.groupFollow && (
            <p>
              Digest group requested
              {preview.digestAudience ? ` for ${preview.digestAudience}` : ""}.
            </p>
          )}
          {preview.issues.length > 0 && (
            <div className="warning-banner" role="alert">
              <h3>Resolve these issues before publishing</h3>
              <ul>
                {preview.issues.map((issue, index) => (
                  <li key={`${issue.field}-${index}`}>{issue.message}</li>
                ))}
              </ul>
            </div>
          )}
          {stale && !entry.publishCommandId && (
            <p className="warning-banner" role="alert">
              Your configuration changed. Close this review and publish again to
              review the current metrics.
            </p>
          )}
          {entry.publishError && (
            <p className="warning-banner" role="alert">
              {entry.publishError}
            </p>
          )}
          {entry.publishBusy && (
            <p role="status">
              Publishing metrics. Results will appear in Activity.
            </p>
          )}
        </Modal>
      )}
    </section>
  );
}
