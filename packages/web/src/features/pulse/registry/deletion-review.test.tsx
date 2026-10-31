import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { reviewedMetricLabel, reviewedFollowerLines, ReviewedMetricFollowers } from "./views";
import type { PulseRegistryMetric } from "../fork-plan";

test("reviewed labels resolve exact IDs including siblings outside selection", () => {
  const metrics = new Map<string, PulseRegistryMetric>([
    ["selected", { metricId: "selected", definitionId: "sales", name: "Revenue", measurementPeriod: null, timeframeLabel: "Month to date" }],
    ["sibling", { metricId: "sibling", definitionId: "sales", name: "Revenue", measurementPeriod: null, timeframeLabel: "Month to date", filters: [{ field: "Region", categorical_values: [{ string_value: "West" }] }] }],
  ]);
  assert.equal(reviewedMetricLabel("selected", metrics), "Revenue - Month to date");
  assert.equal(reviewedMetricLabel("sibling", metrics), "Revenue - Region: West");
  assert.equal(reviewedMetricLabel("absent", metrics), "Metric name unavailable");
  assert.equal(metrics.get("selected")?.metricId, "selected");
});

test("follower details never substitute another metric or treat missing results as zero", () => {
  const details = [{ metricId: "other", followers: [], errors: [] }];
  assert.match(reviewedFollowerLines("reviewed", details)[0].text, /unavailable/);
  assert.equal(reviewedFollowerLines("reviewed", details)[0].error, true);
  assert.equal(reviewedFollowerLines("reviewed", [{ metricId: "reviewed", followers: [], status: "available", errors: [] }])[0].text, "No followers yet");
});

test("partial and unknown identities retain diagnostics and identifiable fallbacks", () => {
  const lines = reviewedFollowerLines("reviewed", [{ metricId: "reviewed", status: "partial", followers: [{ id: "unresolved", name: "", type: "UNKNOWN" }], errors: ["Directory incomplete"] }]);
  assert.equal(lines[0].text, "Unknown - unresolved");
  assert.match(lines[1].text, /partial.*Directory incomplete/);
  assert.equal(lines[1].error, true);
});

test("review follower disclosure starts collapsed and preserves unavailable counts", () => {
  const unavailable = renderToStaticMarkup(<ReviewedMetricFollowers metricId="reviewed" followerCount={null} />);
  assert.match(unavailable, /Followers unavailable/);
  assert.doesNotMatch(unavailable, /open=|Loading followers|No followers/);
  const zero = renderToStaticMarkup(<ReviewedMetricFollowers metricId="reviewed" followerCount={0} />);
  assert.match(zero, /0 followers/);
});
