import { aggregationLabel } from "../metric-labels";
import type { PulsePublishReceipt } from "@pulse-metric-studio/shared";
import { useActivity } from "./controller";
import { ReceiptActions } from "./ReceiptActions";
import "./activity.css";

const followLabels = {
  created: "Added",
  reused: "Already added",
  failed: "Failed",
  unknown: "Unconfirmed",
  skipped: "Skipped",
  not_attempted: "Not sent",
};

export function Receipt({
  receipt,
  onRefresh,
  onActivity,
  showActions = true,
}: {
  receipt: PulsePublishReceipt;
  onRefresh?: () => void;
  onActivity?: () => void;
  showActions?: boolean;
}) {
  const undoError = useActivity((state) =>
    state.undoReceiptId === receipt.id ? state.undoError : null,
  );
  const readError = useActivity((state) =>
    state.readReceiptId === receipt.id ? state.readError : null,
  );
  const followNeedsAttention =
    receipt.follow.requested &&
    [
      receipt.follow.group,
      receipt.follow.membership,
      ...receipt.follow.subscriptions,
    ].some((item) =>
      ["failed", "unknown", "not_attempted"].includes(item.status),
    );
  return (
    <section className="pulse-receipt" aria-label="Publication receipt">
      <header className="pulse-receipt-header">
        <h3>{receipt.datasourceName}</h3>
        <time dateTime={new Date(receipt.createdAt).toISOString()}>
          {new Date(receipt.createdAt).toLocaleString()}
        </time>
      </header>
      <p className="pulse-receipt-summary" role="status">
        {receipt.createdCount} created
        {receipt.failedCount > 0 && `, ${receipt.failedCount} failed`}
        {receipt.unknownCount > 0 && `, ${receipt.unknownCount} unconfirmed`}
        {receipt.unattemptedCount > 0 &&
          `, ${receipt.unattemptedCount} not sent`}
      </p>
      {receipt.publishing && <p role="status">Publishing...</p>}
      {(receipt.interrupted || receipt.unknownCount > 0) && (
        <p className="warning-banner">
          {receipt.unknownCount > 0
            ? "Some results are unconfirmed. Check these metrics in Tableau before publishing again."
            : "Publication stopped before finishing. Review the results below."}
        </p>
      )}
      <ul className="pulse-publication-items">
        {receipt.items.map((item) => (
          <li key={item.itemIndex}>
            <div className="pulse-publication-item-heading">
              <strong>{item.name}</strong>
              <span
                className={
                  item.creationStatus === "created" ? "" : "needs-attention"
                }
              >
                {item.undoStatus === "deleted"
                  ? "Deleted"
                  : item.creationStatus === "created"
                    ? "Created"
                    : item.creationStatus === "unknown"
                      ? "Unconfirmed"
                      : item.creationStatus === "not_attempted"
                        ? "Not sent"
                        : "Not created"}
              </span>
            </div>
            {item.creationStatus === "created" &&
              item.resolutionStatus !== "resolved" &&
              item.undoStatus !== "deleted" && (
                <p>
                  {item.resolutionStatus === "failed"
                    ? "Created, but its default metric could not be found."
                    : "Created. Waiting for its default metric to appear in Tableau."}
                </p>
              )}
            {item.diagnostic && (
              <p className="needs-attention">{item.diagnostic.message}</p>
            )}
            {(item.undoStatus === "failed" ||
              item.undoStatus === "unknown") && (
              <p className="needs-attention">
                {item.undoStatus === "unknown"
                  ? "Deletion is unconfirmed."
                  : "Could not delete this metric."}
                {item.undoDiagnostic && ` ${item.undoDiagnostic.message}`}
              </p>
            )}
            <details className="pulse-publication-details">
              <summary>Metric details</summary>
              <dl>
                <dt>Calculation</dt>
                <dd>
                  {aggregationLabel(item.summary.aggregation)}{" "}
                  of {item.summary.fieldLabel}
                </dd>
                <dt>Date field</dt>
                <dd>{item.summary.timeDimensionLabel || "Unavailable"}</dd>
                <dt>Slicers</dt>
                <dd>
                  {item.summary.slicers
                    .map((field) => field.fieldLabel)
                    .join(", ") || "None"}
                </dd>
                {item.summary.cumulative && (
                  <>
                    <dt>Cumulative</dt>
                    <dd>Yes</dd>
                  </>
                )}
              </dl>
            </details>
          </li>
        ))}
      </ul>
      {receipt.follow.requested && (
        <details
          className="pulse-publication-follow"
          open={followNeedsAttention || undefined}
        >
          <summary>
            Digest group{followNeedsAttention ? " - needs attention" : ""}
          </summary>
          <p>
            {receipt.follow.group.name || "Group"}:{" "}
            {followLabels[receipt.follow.group.status]}
          </p>
          {receipt.follow.group.error && (
            <p className="needs-attention">{receipt.follow.group.error}</p>
          )}
          <p>
            Your membership: {followLabels[receipt.follow.membership.status]}
          </p>
          {receipt.follow.membership.error && (
            <p className="needs-attention">{receipt.follow.membership.error}</p>
          )}
          <ul>
            {receipt.follow.subscriptions.map((item) => (
              <li key={item.itemIndex}>
                {receipt.items.find(
                  (metric) => metric.itemIndex === item.itemIndex,
                )?.name || `Metric ${item.itemIndex + 1}`}
                : {followLabels[item.status]}
                {item.error && <p className="needs-attention">{item.error}</p>}
              </li>
            ))}
          </ul>
        </details>
      )}
      {undoError && (
        <p className="warning-banner" role="alert">
          {undoError}
        </p>
      )}
      {readError && (
        <p className="warning-banner" role="alert">
          {readError}
        </p>
      )}
      {(onRefresh || onActivity) && <div className="pulse-button-row pulse-receipt-actions">
        {onRefresh && (
          <button className="btn small" onClick={onRefresh}>
            Refresh results
          </button>
        )}
        {onActivity && (
          <button className="btn small" onClick={onActivity}>
            View in Activity
          </button>
        )}
      </div>}
      {showActions && <ReceiptActions key={receipt.id} receipt={receipt} />}
    </section>
  );
}
