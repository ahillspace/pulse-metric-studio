import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { PulseMetricPreview } from "@pulse-metric-studio/shared";
import {
  createPreviewController,
  type PreviewScope,
} from "./preview-controller";
import { MetricPreview } from "./MetricPreview";
import { PulseApiError } from "../api/client";
import { pulseMetricUrl } from "../shell/tableau-links";

const scope: PreviewScope = {
  context: {
    connectionId: "connection",
    serverUrl: "https://tableau.example",
    siteId: "site",
    datasourceLuid: "source",
  },
  siteContentUrl: "sales",
};
const metric = (metricId: string) => ({
  metricId,
  definitionId: "definition",
  name: `Revenue ${metricId}`,
  timeframeLabel: "Month to date",
  measurementPeriod: {},
});
const image = (metricId: string): PulseMetricPreview => ({
  metricId,
  definitionId: "definition",
  name: `Revenue ${metricId}`,
  imageDataUrl: "data:image/png;base64,aW1hZ2U=",
  generatedAt: 1,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
test("changing preview selection discards the previous request", async () => {
  const first = deferred<PulseMetricPreview>();
  const second = deferred<PulseMetricPreview>();
  const store = createPreviewController(async (_context, id) =>
    id === "one" ? first.promise : second.promise,
  );
  store.getState().setScope(scope);
  const one = store.getState().show(metric("one"));
  const two = store.getState().show(metric("two"));
  second.resolve(image("two"));
  await two;
  first.resolve(image("one"));
  await one;
  assert.equal(store.getState().image?.metricId, "two");
});
test("session or inventory scope changes discard visible and pending preview data", async () => {
  const response = deferred<PulseMetricPreview>();
  const store = createPreviewController(async () => response.promise);
  store.getState().setScope(scope);
  const request = store.getState().show(metric("one"));
  store.getState().setScope({ ...scope });
  response.resolve(image("one"));
  await request;
  assert.equal(store.getState().image, null);
  assert.equal(store.getState().metric, null);
  assert.equal(store.getState().loading, false);
});
test("closing the pane invalidates a pending preview", async () => {
  const response = deferred<PulseMetricPreview>();
  const store = createPreviewController(async () => response.promise);
  store.getState().setScope(scope);
  const request = store.getState().show(metric("one"));
  store.getState().close();
  response.resolve(image("one"));
  await request;
  assert.equal(store.getState().image, null);
  assert.equal(store.getState().metric, null);
});
test("refresh clears the prior image and retains selected metric", async () => {
  let count = 0;
  const store = createPreviewController(async (_context, id) => {
    count++;
    return image(id);
  });
  store.getState().setScope(scope);
  await store.getState().show(metric("one"));
  const pending = store.getState().refresh();
  assert.equal(store.getState().image, null);
  assert.equal(store.getState().metric?.metricId, "one");
  await pending;
  assert.equal(count, 2);
  assert.equal(store.getState().image?.metricId, "one");
});
test("provider identity mismatch never renders another metric's card", async () => {
  const store = createPreviewController(async () => image("other"));
  store.getState().setScope(scope);
  await store.getState().show(metric("one"));
  assert.equal(store.getState().image, null);
  assert.match(store.getState().error!, /different metric/);
});
test("preview displays returned PNG with named controls and truthful unavailable state", async () => {
  const store = createPreviewController(async () => image("one"));
  store.getState().setScope(scope);
  await store.getState().show(metric("one"));
  const html = renderToStaticMarkup(<MetricPreview state={store.getState()} />);
  assert.match(html, /data:image\/png;base64/);
  assert.match(html, /Revenue one/);
  assert.match(html, /Close metric preview/);
  assert.match(html, /Open in Pulse/);
  const failed = createPreviewController(async () => {
    throw new PulseApiError("Not found", 501, "pulse_preview_unsupported");
  });
  failed.getState().setScope(scope);
  await failed.getState().show(metric("one"));
  const unavailable = renderToStaticMarkup(
    <MetricPreview state={failed.getState()} />,
  );
  assert.match(unavailable, /does not support metric previews yet/);
  assert.doesNotMatch(unavailable, /<img/);
});
test("metric links encode site and metric identity without forwarding URL query data", () => {
  assert.equal(
    pulseMetricUrl(
      "https://tableau.example/path?token=bad#other",
      "sales & ops",
      "a/b",
    ),
    "https://tableau.example/pulse/site/sales%20%26%20ops/metrics/a%2Fb",
  );
  assert.throws(
    () => pulseMetricUrl("javascript:alert(1)", "site", "metric"),
    /Unsupported/,
  );
});

test("browser image failure keeps recovery actions and refresh resets the error", async () => {
  const store = createPreviewController(async (_context, id) => image(id));
  store.getState().setScope(scope);
  await store.getState().show(metric("one"));
  store.getState().imageFailed(store.getState().image!);
  const failed = renderToStaticMarkup(
    <MetricPreview state={store.getState()} />,
  );
  assert.match(failed, /preview image could not display/);
  assert.match(failed, /Refresh/);
  assert.match(failed, /Open in Pulse/);
  assert.doesNotMatch(failed, /<img/);
  await store.getState().refresh();
  assert.equal(store.getState().error, null);
  assert.equal(store.getState().image?.metricId, "one");
});

test("a stale browser image error cannot clear a newer preview", async () => {
  const store = createPreviewController(async (_context, id) => image(id));
  store.getState().setScope(scope);
  await store.getState().show(metric("one"));
  const previous = store.getState().image!;
  await store.getState().show(metric("two"));
  store.getState().imageFailed(previous);
  assert.equal(store.getState().error, null);
  assert.equal(store.getState().image?.metricId, "two");
  await store.getState().refresh();
  const refreshed = store.getState().image;
  store.getState().imageFailed(previous);
  assert.equal(store.getState().image, refreshed);
});
