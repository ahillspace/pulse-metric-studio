import { useEffect, useState } from "react";
import type {
  PulseDraftContext,
  PulseMetricPreview,
  PulsePublishItemReceipt,
} from "@pulse-metric-studio/shared";
import { calculationLabel } from "../metric-labels";
import { requestMetricPreview } from "../registry/preview-controller";
import { openTableauUrl, pulseMetricUrl } from "../shell/tableau-links";
import type { SessionOwner } from "../shell/session-events";

/** Cards that load their preview without a click; the rest load on demand. */
export const AUTO_PREVIEW_COUNT = 3;

/** Owned by the publication result, so confirmation subtrees can unmount safely. */
export function createPublishedPreviewCache(transport = requestMetricPreview) {
  let scope = "";
  const entries = new Map<string, Promise<PulseMetricPreview>>();
  return {
    setScope(next: string) { if (scope !== next) { scope = next; entries.clear(); } },
    load(context: PulseDraftContext, metricId: string, definitionId: string | null | undefined, refresh = false) {
      const key = JSON.stringify([scope, metricId, definitionId]);
      if (refresh) entries.delete(key);
      const existing = entries.get(key);
      if (existing) return existing;
      const request = transport(context, metricId).then((image) => {
        if (image.metricId !== metricId || image.definitionId !== definitionId)
          throw new Error("Tableau returned a preview for a different metric.");
        return image;
      });
      entries.set(key, request);
      while (entries.size > 16) entries.delete(entries.keys().next().value!);
      void request.catch(() => { if (entries.get(key) === request) entries.delete(key); });
      return request;
    },
  };
}

type PreviewLoad =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; image: PulseMetricPreview }
  | { status: "error"; message: string };

interface Props {
  items: PulsePublishItemReceipt[];
  /** Present when the current Tableau session can render previews and links. */
  live: { context: PulseDraftContext; siteContentUrl: string; owner?: SessionOwner } | null;
  previews: ReturnType<typeof createPublishedPreviewCache>;
  previewScope: string;
  onLinkError(message: string): void;
}

export function PublishedMetrics({ items, live, onLinkError, previews, previewScope }: Props) {
  if (items.length === 0) return null;
  return (
    <ul className="pulse-published-metrics" aria-label="Published metrics">
      {items.map((item, index) => (
        <PublishedMetric
          key={`${previewScope}:${item.itemIndex}`}
          item={item}
          live={live}
          autoPreview={index < AUTO_PREVIEW_COUNT}
          previews={previews}
          previewScope={previewScope}
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
  previews,
  previewScope,
}: {
  item: PulsePublishItemReceipt;
  live: Props["live"];
  autoPreview: boolean;
  previews: Props["previews"];
  previewScope: string;
  onLinkError(message: string): void;
}) {
  const [preview, setPreview] = useState<PreviewLoad>({ status: "idle" });
  const resolved = item.resolutionStatus === "resolved" && Boolean(item.metricId);
  const canPreview = Boolean(live && resolved);
  const slicers = item.summary.slicers.length;

  const load = (refresh = false) => {
    if (!live || !item.metricId) return () => {};
    let current = true;
    setPreview({ status: "loading" });
    previews.load(live.context, item.metricId, item.definitionId, refresh)
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
    setPreview({ status: "idle" });
    if (autoPreview && canPreview) return load();
    return undefined;
  }, [autoPreview, canPreview, item.metricId, previewScope]);

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
          {canPreview && (preview.status === "ready" || preview.status === "error") && (
            <button className="btn small" type="button" onClick={() => load(true)}>Refresh preview</button>
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
