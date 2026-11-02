import { useEffect, useState } from "react";
import type {
  PulseDraftContext,
  PulseMetricPreview,
  PulsePublishItemReceipt,
} from "@pulse-metric-studio/shared";
import { calculationLabel } from "../metric-labels";
import { requestMetricPreview } from "../registry/preview-controller";
import { openTableauUrl, pulseMetricUrl } from "../shell/tableau-links";

/** Cards that load their preview without a click; the rest load on demand. */
export const AUTO_PREVIEW_COUNT = 3;

type PreviewLoad =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; image: PulseMetricPreview }
  | { status: "error"; message: string };

interface Props {
  items: PulsePublishItemReceipt[];
  /** Present when the current Tableau session can render previews and links. */
  live: { context: PulseDraftContext; siteContentUrl: string } | null;
  onLinkError(message: string): void;
}

export function PublishedMetrics({ items, live, onLinkError }: Props) {
  if (items.length === 0) return null;
  return (
    <ul className="pulse-published-metrics" aria-label="Published metrics">
      {items.map((item, index) => (
        <PublishedMetric
          key={item.itemIndex}
          item={item}
          live={live}
          autoPreview={index < AUTO_PREVIEW_COUNT}
          onLinkError={onLinkError}
        />
      ))}
    </ul>
  );
}

function PublishedMetric({
  item,
  live,
  autoPreview,
  onLinkError,
}: {
  item: PulsePublishItemReceipt;
  live: Props["live"];
  autoPreview: boolean;
  onLinkError(message: string): void;
}) {
  const [preview, setPreview] = useState<PreviewLoad>({ status: "idle" });
  const resolved = item.resolutionStatus === "resolved" && Boolean(item.metricId);
  const canPreview = Boolean(live && resolved);
  const slicers = item.summary.slicers.length;

  const load = () => {
    if (!live || !item.metricId) return () => {};
    let current = true;
    setPreview({ status: "loading" });
    requestMetricPreview(live.context, item.metricId)
      .then((image) => {
        if (!current) return;
        if (image.metricId !== item.metricId || image.definitionId !== item.definitionId)
          throw new Error("Tableau returned a preview for a different metric.");
        setPreview({ status: "ready", image });
      })
      .catch((error: unknown) => {
        if (current)
          setPreview({
            status: "error",
            message: error instanceof Error ? error.message : "The preview could not load.",
          });
      });
    return () => {
      current = false;
    };
  };

  useEffect(() => {
    if (autoPreview && canPreview) return load();
    return undefined;
  }, [autoPreview, canPreview, item.metricId]);

  return (
    <li className="pulse-published-metric">
      <div className="pulse-published-metric-heading">
        <div>
          <strong>{item.name}</strong>
          <span>
            {calculationLabel(item.summary)}
            {slicers > 0 && ` · ${slicers} ${slicers === 1 ? "slicer" : "slicers"}`}
          </span>
        </div>
        <div className="pulse-published-metric-actions">
          {!resolved && <span className="pulse-published-metric-state">Syncing</span>}
          {canPreview && preview.status === "idle" && (
            <button className="btn small" type="button" onClick={() => load()}>
              Preview
            </button>
          )}
          <button
            className="btn small"
            type="button"
            disabled={!live || !item.metricId}
            onClick={() => {
              if (!live || !item.metricId) return;
              void openTableauUrl(
                pulseMetricUrl(live.context.serverUrl, live.siteContentUrl, item.metricId),
              ).catch((error: unknown) =>
                onLinkError(error instanceof Error ? error.message : "Could not open Tableau Pulse."),
              );
            }}
          >
            Open in Pulse
          </button>
        </div>
      </div>
      {preview.status !== "idle" && (
        <div className="pulse-published-metric-preview" aria-busy={preview.status === "loading"}>
          {preview.status === "loading" && <p role="status">Loading preview...</p>}
          {preview.status === "error" && <p role="alert">{preview.message}</p>}
          {preview.status === "ready" && (
            <img
              src={preview.image.imageDataUrl}
              alt={`${item.name} preview`}
              onError={() => setPreview({ status: "error", message: "The preview image could not display." })}
            />
          )}
        </div>
      )}
    </li>
  );
}
