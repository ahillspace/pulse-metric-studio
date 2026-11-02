import { useState } from "react";
import type { PreviewState } from "./preview-controller";
import { openTableauUrl, pulseMetricUrl } from "../shell/tableau-links";

export function MetricPreview({ state }: { state: PreviewState }) {
  const [linkError, setLinkError] = useState<string | null>(null);
  const { metric, scope, image } = state;
  if (!metric || !scope) return null;
  return (
    <aside
      className="pulse-metric-preview"
      aria-label={`Preview ${metric.name}`}
    >
      <header>
        <h3>{metric.name}</h3>
        <button
          className="btn small pulse-registry-icon"
          type="button"
          aria-label="Close metric preview"
          title="Close preview"
          onClick={state.close}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="m5 5 10 10M15 5 5 15" />
          </svg>
        </button>
      </header>
      <p className="pulse-preview-timeframe">{metric.timeframeLabel}</p>
      <div className="pulse-preview-content" aria-busy={state.loading}>
        {state.loading && <p role="status">Loading preview...</p>}
        {state.error && <p role="alert">{state.error}</p>}
        {image && (
          <img
            key={`${image.generatedAt}:${image.imageDataUrl}`}
            src={image.imageDataUrl}
            alt={`${metric.name} - ${metric.timeframeLabel}`}
            onError={() => state.imageFailed(image)}
          />
        )}
      </div>
      <footer>
        <button
          className="btn small"
          type="button"
          disabled={state.loading}
          onClick={() => void state.refresh()}
        >
          Refresh
        </button>
        <button
          className="btn small"
          type="button"
          onClick={() => {
            setLinkError(null);
            void openTableauUrl(
              pulseMetricUrl(
                scope.context.serverUrl,
                scope.siteContentUrl,
                metric.metricId,
              ),
            ).catch((error: unknown) =>
              setLinkError(
                error instanceof Error
                  ? error.message
                  : "Could not open Tableau Pulse.",
              ),
            );
          }}
        >
          Open in Pulse
        </button>
      </footer>
      {linkError && <p role="alert">{linkError}</p>}
    </aside>
  );
}
