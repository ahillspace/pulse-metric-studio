import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { reviewedDefinitionLabel, reviewedMetricLabel, reviewedFollowerLines, ReviewedMetricFollowers } from "./views";
import type { PulseRegistryMetric } from "../fork-plan";
import { inventory } from "../testing/fixtures";

test("reviewed labels prefer fresh plan names and retain cached friendly fallbacks by exact ID", () => {
  const metrics = new Map<string, PulseRegistryMetric>([
    ["selected", { metricId: "selected", definitionId: "sales", name: "Revenue", measurementPeriod: null, timeframeLabel: "Month to date" }],
    ["sibling", { metricId: "sibling", definitionId: "sales", name: "Revenue", measurementPeriod: null, timeframeLabel: "Month to date", filters: [{ field: "Region", categorical_values: [{ string_value: "West" }] }] }],
  ]);
  assert.equal(reviewedMetricLabel("selected", metrics), "Revenue - Month to date");
  assert.equal(reviewedMetricLabel("sibling", metrics), "Revenue - Region: West");
  assert.equal(reviewedMetricLabel("absent", metrics), "Metric name unavailable");
  assert.equal(reviewedMetricLabel("selected", metrics, "  Updated Revenue  "), "Updated Revenue");
  assert.equal(reviewedMetricLabel("sibling", metrics, "Updated West Revenue"), "Updated West Revenue");
  assert.equal(reviewedMetricLabel("absent", metrics, "New Enterprise"), "New Enterprise");
  for (const name of ["", "   ", "selected", "E1F32575-0837-4018-9912-AD1EFF3F2599"]) {
    assert.equal(reviewedMetricLabel("selected", metrics, name), "Revenue - Month to date");
  }
  assert.equal(reviewedMetricLabel("sibling", metrics, "sibling"), "Revenue - Region: West");
  assert.equal(metrics.get("selected")?.metricId, "selected");
});

test("definition labels prefer the plan and never use raw cached identities as their fallback", () => {
  const definition = inventory().definitions[0];
  definition.name = "Cached Revenue";
  const definitions = new Map([[definition.definitionId, definition]]);
  assert.equal(reviewedDefinitionLabel(definition.definitionId, definitions, "Updated Revenue"), "Updated Revenue");
  assert.equal(reviewedDefinitionLabel(definition.definitionId, definitions, ""), "Cached Revenue");
  assert.equal(reviewedDefinitionLabel("absent", definitions, "New Enterprise"), "New Enterprise");
  for (const name of ["", definition.definitionId, "e1f32575-0837-4018-9912-ad1eff3f2599"]) {
    definition.name = name;
    assert.equal(reviewedDefinitionLabel(definition.definitionId, definitions, ""), "Definition name unavailable");
  }
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
