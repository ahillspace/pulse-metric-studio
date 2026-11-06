import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create } from "react-test-renderer";
import type { PulseDeletePlan } from "@pulse-metric-studio/shared";
import { ExistingMetrics } from "../components/ExistingMetrics";
import { useAuthor, type DraftEditor } from "../author/controller";
import { useConnection } from "../connections/controller";
import { createRegistryController, useRegistry } from "./controller";
import { unavailableFollowState } from "../follow-state";
import { draft, inventory, session } from "../testing/fixtures";

function reviewFixture(t: TestContext) {
  const originalAuthor = useAuthor.getState();
  const originalConnection = useConnection.getState();
  const originalRegistry = useRegistry.getState();
  t.after(() => {
    useAuthor.setState(originalAuthor, true);
    useConnection.setState(originalConnection, true);
    useRegistry.setState(originalRegistry, true);
  });
  // Use current Zustand snapshots in SSR, preserving the production components
  // and label resolvers while exercising an older inventory and a newer plan.
  t.mock.method(React, "useSyncExternalStore", <T,>(_subscribe: unknown, getSnapshot: () => T) => getSnapshot());
  const record = draft();
  const entry: DraftEditor = {
    record, document: record.document, sequence: 0, savedSequence: 0,
    saveStatus: "saved", saveError: null, catalog: null,
    catalogLoading: false, catalogError: null, proposal: null,
    proposalSequence: 0, proposalBase: null, configurationEpoch: 0,
    proposalEpoch: 0, proposalNotice: null, proposalBusy: false,
    proposalMessage: "", proposalError: null, composer: "", preview: null,
    previewSequence: 0, previewBusy: false, publishBusy: false,
    publishError: null, publishCommandId: null, receipt: null,
  };
  useAuthor.setState({ activeId: record.id, entries: { [record.id]: entry } });
  useConnection.setState({ session });
  const cached = inventory("cached-month");
  cached.definitions[0].name = "Cached Revenue Definition";
  cached.definitions[0].metrics[0].name = "Cached Monthly Revenue";
  cached.definitions[0].metrics.push({
    ...cached.definitions[0].metrics[0], metricId: "cached-region",
    name: "Cached Regional Revenue",
    filters: [{ field: "Region", categorical_values: [{ string_value: "West" }] }],
  });
  const individual = inventory("individual").definitions[0];
  individual.name = "Cached Bookings Definition";
  individual.metrics[0].name = "Cached Bookings";
  cached.definitions.push(individual);
  useRegistry.setState({
    context: record.context, inventory: cached, followState: null,
    loading: false, busy: null, deleteLoading: false, deleteError: null,
    deleteOverridable: false, results: null,
  });
  return (targets: PulseDeletePlan["targets"]) => {
    const plan: PulseDeletePlan = {
      snapshotId: cached.snapshotId,
      context: record.context, metricIds: targets.filter((item) => item.kind === "metric").map((item) => item.id),
      definitionIds: targets.filter((item) => item.kind === "definition").map((item) => item.id),
      allowIncompleteInventory: true, previewFingerprint: "fresh-plan-fingerprint",
      targets, warnings: ["Some follower counts are unavailable."],
    };
    const snapshot = structuredClone(plan);
    useRegistry.setState({ deletePlan: plan });
    const html = renderToStaticMarkup(<ExistingMetrics />);
    const start = html.indexOf('class="overlay-backdrop pulse-deletion-review"');
    assert.ok(start >= 0, "the actual Manager renders the deletion review");
    assert.deepEqual(useRegistry.getState().deletePlan, snapshot, "rendering preserves the reviewed IDs and fingerprint");
    return html.slice(start);
  };
}

test("denied cached deletion leaves one usable results dialog without reopening review", async (t) => {
  reviewFixture(t);
  const browserGlobals = ["window", "document", "HTMLElement"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.defineProperty(globalThis, "document", { configurable: true, value: Object.assign(new EventTarget(), { activeElement: null }) });
  Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout } });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: class {} });
  t.after(() => {
    for (const [key, descriptor] of browserGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const cached = useRegistry.getState().inventory!;
  const context = draft().context;
  const calls: string[] = [];
  const local = createRegistryController({
    inventory: async () => { calls.push("inventory"); return cached; },
    followState: async (ids: string[]) => { calls.push("counts"); return unavailableFollowState(ids, "unavailable"); },
  } as any, {
    previewDelete: async (input) => { calls.push("cached-preview"); return { ...input, previewFingerprint: "cached", warnings: [],
      targets: [{ kind: "metric", id: "cached-month", name: "Cached Monthly Revenue", definitionId: "definition-cached-month", inventoryComplete: true, affectedMetricIds: ["cached-month"] }] }; },
    delete: async (input) => {
      assert.deepEqual(input.metricIds, ["cached-month"]); assert.deepEqual(input.definitionIds, []);
      calls.push("DELETE cached-month");
      return { definitionsDeleted: 0, metricsDeleted: 0, failures: ["This account cannot delete the selected metric."],
        outcomes: [{ metricId: "cached-month", status: "failed", error: "This account cannot delete the selected metric." }] };
    },
  });
  local.getState().setContext(context, "A", session); await local.getState().load();
  useRegistry.setState(local.getState(), true);
  const unsubscribe = local.subscribe(state => useRegistry.setState(state, true)); t.after(unsubscribe);
  await local.getState().previewDelete(["cached-month"], []);
  assert.deepEqual(calls, ["inventory", "counts", "cached-preview"]);
  await local.getState().executeDelete();
  const render = () => renderToStaticMarkup(<ExistingMetrics />);
  const html = render();
  assert.equal((html.match(/role="dialog"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /Review deletion/);
  assert.match(html, /Delete results/); assert.match(html, /This account cannot delete the selected metric/);
  assert.match(html, /<button class="btn primary" type="button">Done<\/button>/);
  let view!: ReturnType<typeof create>;
  act(() => { view = create(<ExistingMetrics visible={false} />); });
  act(() => view.root.findAll((node) => node.type === "button" && node.children.includes("Done"))[0].props.onClick());
  act(() => view.unmount());
  assert.doesNotMatch(render(), /role="dialog"|Review deletion|Delete results/);
  assert.deepEqual(calls, ["inventory", "counts", "cached-preview", "DELETE cached-month"], "selected deletion does not reload inventory or counts");
});

test("Manager deletion review uses fresh names for renamed resources and a sibling absent from cached inventory", (t) => {
  const render = reviewFixture(t);
  const html = render([
    {
      kind: "definition", id: "definition-cached-month", name: "Renamed Revenue Definition",
      definitionId: "definition-cached-month", inventoryComplete: true,
      affectedMetricIds: ["cached-month", "cached-region", "new-enterprise"],
      affectedMetrics: [
        { id: "cached-month", name: "Renamed Monthly Revenue", followerCount: 5 },
        { id: "cached-region", name: "Renamed Regional Revenue", followerCount: 0 },
        { id: "new-enterprise", name: "New Enterprise", followerCount: null },
      ],
    },
    {
      kind: "metric", id: "individual", name: "Renamed Bookings", definitionId: "definition-individual",
      inventoryComplete: true, affectedMetricIds: ["individual"],
      affectedMetrics: [{ id: "individual", name: "Renamed Bookings", followerCount: null }],
    },
  ]);
  assert.match(html, /<strong class="pulse-deletion-name">Renamed Revenue Definition<\/strong>/);
  assert.match(html, /<strong class="pulse-deletion-name">Renamed Bookings<\/strong>/);
  for (const name of ["Renamed Monthly Revenue", "Renamed Regional Revenue", "New Enterprise"]) {
    assert.ok(html.includes(name), name);
  }
  assert.doesNotMatch(html, /Cached|Month to date|Region: West|name unavailable|Exact (?:metric|definition) ID/);
  assert.match(html, /definition and its 3 metrics/);
  assert.match(html, /5 followers/);
  assert.match(html, /0 followers/);
  assert.equal((html.match(/Followers unavailable/g) ?? []).length, 2);
  assert.match(html, /Some follower counts are unavailable/);
  assert.match(html, /Delete reviewed resources/);
});

test("Manager deletion review discloses exact IDs for missing plan names, including cached fallbacks and unknown resources", (t) => {
  const render = reviewFixture(t);
  const rawUuid = "00000000-0000-4000-8000-000000000004";
  for (const name of [() => "", () => "   ", () => rawUuid, (id: string) => id]) {
    const html = render([
      {
        kind: "definition", id: "definition-cached-month", name: name("definition-cached-month"),
        definitionId: "definition-cached-month", inventoryComplete: false,
        affectedMetricIds: ["cached-month", "cached-region", "unknown-child"],
        affectedMetrics: ["cached-month", "cached-region", "unknown-child"].map((id) => ({ id, name: name(id), followerCount: null })),
      },
      {
        kind: "metric", id: "unknown-metric", name: name("unknown-metric"), definitionId: null,
        inventoryComplete: false, affectedMetricIds: ["unknown-metric"],
      },
      {
        kind: "definition", id: "unknown-definition", name: name("unknown-definition"), definitionId: "unknown-definition",
        inventoryComplete: false, affectedMetricIds: [],
      },
    ]);
    assert.match(html, /<strong class="pulse-deletion-name">Cached Revenue Definition<\/strong>/);
    assert.match(html, /Cached Monthly Revenue - Month to date/);
    assert.match(html, /Cached Regional Revenue - Region: West/);
    assert.match(html, /<strong class="pulse-deletion-name">Metric name unavailable<\/strong>/);
    assert.match(html, /<strong class="pulse-deletion-name">Definition name unavailable<\/strong>/);
    const disclosures = [...html.matchAll(/<details class="pulse-deletion-id"><summary>Exact (metric|definition) ID<\/summary><code>([^<]+)<\/code><\/details>/g)];
    assert.deepEqual(disclosures.map((match) => [match[1], match[2]]), [
      ["definition", "definition-cached-month"], ["metric", "cached-month"],
      ["metric", "cached-region"], ["metric", "unknown-child"],
      ["metric", "unknown-metric"], ["definition", "unknown-definition"],
    ]);
    const primaryText = html.replace(/<details class="pulse-deletion-id">.*?<\/details>/g, "").replace(/<[^>]*>/g, "");
    assert.doesNotMatch(primaryText, /cached-month|cached-region|unknown-child|unknown-metric|unknown-definition|e1f32575/);
    assert.equal((html.match(/Followers unavailable/g) ?? []).length, 3);
    assert.doesNotMatch(html, /0 followers|open=""/);
    assert.match(html, /inventory incomplete, 3 listed/);
    assert.match(html, /individual metric, deleted by ID/);
  }
});
