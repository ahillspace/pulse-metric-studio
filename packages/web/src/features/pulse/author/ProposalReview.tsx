import type { DraftEditor } from "./controller";
import { describePulseDocumentChanges, mergePulseProposal } from "@pulse-metric-studio/shared";
import { useAuthor } from "./controller";
import { aggregationLabels } from "./MetricTable";
import {
  summarizeProposal,
  type ProposalSummaryItem,
} from "./proposal-summary";

function ChangeList({
  title,
  items,
}: {
  title: string;
  items: ProposalSummaryItem[];
}) {
  return (
    <div className="pulse-proposal-change-group">
      <h4>{title}</h4>
      {items.length ? (
        <ul>
          {items.map((item) => (
            <li key={item.id}>
              <span>{item.name}</span>
              <span className={`pulse-change-${item.status.toLowerCase()}`}>
                {item.status}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p>No changes</p>
      )}
    </div>
  );
}

export function ProposalReview({ entry }: { entry: DraftEditor }) {
  if (!entry.proposal) return null;
  const proposal = entry.proposal;
  const merged = mergePulseProposal(
    entry.proposalBase ?? entry.document,
    proposal.candidateDocument,
    entry.document,
    entry.proposalEpoch !== entry.configurationEpoch,
  );
  const summary = summarizeProposal(entry.document, merged.document);
  const changes = describePulseDocumentChanges(entry.document, merged.document, entry.catalog);
  return (
    <section className="pulse-proposal" aria-label="Proposed draft changes">
      {merged.skipped.length > 0 && <p className="section-hint">Your newer or protected edits are kept in this preview.</p>}
      <details open className="pulse-proposal-diff">
        <summary>Measures and filters</summary>
        <ChangeList title="Measures" items={summary.measures} />
        <ChangeList title="Filters" items={summary.filters} />
      </details>
      <details className="pulse-proposal-detail">
        <summary>Review all changes ({changes.length})</summary>
        <ul>
          {changes.map((change, index) => (
            <li key={`${change.field}-${index}`}>{change.message}</li>
          ))}
        </ul>
      </details>
      <details open className="pulse-proposal-result">
        <summary>Review resulting metrics</summary>
        <ul>
          {Object.values(merged.document.metrics)
            .filter((metric) => metric.active)
            .map((metric) => (
              <li key={metric.fieldId}>
                <strong>{metric.name}</strong>
                <span>
                  {aggregationLabels[metric.aggregation] ?? metric.aggregation}{" "}
                  of {metric.fieldLabel} ·{" "}
                  {entry.catalog?.timeDimensions.find(
                    (field) => field.id === metric.timeDimensionFieldId,
                  )?.label ?? "Date field needed"}
                </span>
              </li>
            ))}
        </ul>
      </details>
      <div className="pulse-button-row">
        <button
          className="btn primary"
          onClick={() => void useAuthor.getState().acceptProposal()}
        >
          Apply changes
        </button>
        <button
          className="btn"
          onClick={() => useAuthor.getState().discardProposal()}
        >
          Discard proposal
        </button>
      </div>
    </section>
  );
}
