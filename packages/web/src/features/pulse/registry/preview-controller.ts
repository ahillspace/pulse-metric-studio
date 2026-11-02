import { create } from "zustand";
import type {
  PulseDraftContext,
  PulseMetricPreview,
} from "@pulse-metric-studio/shared";
import { PulseMetricPreviewSchema } from "@pulse-metric-studio/shared";
import type { PulseRegistryMetric } from "../fork-plan";
import { PulseApiError, pulseRequest } from "../api/client";

export interface PreviewScope {
  context: PulseDraftContext;
  siteContentUrl: string;
}
export interface PreviewState {
  scope: PreviewScope | null;
  metric: PulseRegistryMetric | null;
  loading: boolean;
  image: PulseMetricPreview | null;
  error: string | null;
  setScope(scope: PreviewScope | null): void;
  show(metric: PulseRegistryMetric): Promise<void>;
  refresh(): Promise<void>;
  imageFailed(image: PulseMetricPreview): void;
  close(): void;
}

export async function requestMetricPreview(context: PulseDraftContext, metricId: string) {
  return PulseMetricPreviewSchema.parse(
    await pulseRequest(
      `/api/pulse/metrics/${encodeURIComponent(metricId)}/preview`,
      "POST",
      { context },
    ),
  );
}

export function createPreviewController(transport = requestMetricPreview) {
  let generation = 0;
  return create<PreviewState>((set, get) => ({
    scope: null,
    metric: null,
    loading: false,
    image: null,
    error: null,
    setScope(scope) {
      if (scope === get().scope) return;
      generation += 1;
      set({ scope, metric: null, loading: false, image: null, error: null });
    },
    async show(metric) {
      const scope = get().scope;
      if (!scope) return;
      const request = ++generation;
      set({ metric, loading: true, image: null, error: null });
      try {
        const image = await transport(scope.context, metric.metricId);
        if (request !== generation || scope !== get().scope) return;
        if (
          image.metricId !== metric.metricId ||
          image.definitionId !== metric.definitionId
        ) {
          throw new Error("Tableau returned a preview for a different metric.");
        }
        set({ loading: false, image });
      } catch (error) {
        if (request !== generation || scope !== get().scope) return;
        set({
          loading: false,
          image: null,
          error:
            error instanceof PulseApiError &&
            error.code === "pulse_preview_unsupported"
              ? "This Tableau site does not support metric previews yet."
              : error instanceof Error
                ? error.message
                : "The metric preview could not load.",
        });
      }
    },
    async refresh() {
      const metric = get().metric;
      if (metric) await get().show(metric);
    },
    imageFailed(image) {
      if (get().image !== image) return;
      set({
        image: null,
        error: "The preview image could not display. Try refreshing it.",
      });
    },
    close() {
      generation += 1;
      set({ metric: null, loading: false, image: null, error: null });
    },
  }));
}
