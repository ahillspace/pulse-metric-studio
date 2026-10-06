import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { PublicationResult } from "./PublicationResult";
import { pulseSiteUrl } from "../shell/tableau-links";
import { inventoryCounts } from "../registry/InventoryCounts";
import { inventory, receipt } from "../testing/fixtures";

test("publication result summarizes creation, preserves error code and message, and uses approved audience", () => {
  const result = receipt();
  result.digestAudience = "Sales leadership";
  result.siteContentUrl = "sales";
  result.follow.group = { status: "created", id: "group", name: "pmStudio - Source - Sales leadership" };
  result.items.push({ ...result.items[0], itemIndex: 1, name: "Profit", creationStatus: "not_created", diagnostic: { code: "400123", message: "The date field is unavailable." } });
  result.failedCount = 1;
  const html = renderToStaticMarkup(<PublicationResult receipt={result} onClose={() => {}} onActivity={() => {}} />);
  assert.match(html, /1 metric created/);
  assert.match(html, /400123: The date field is unavailable/);
  assert.match(html, /Delete &quot;Sales leadership&quot; Group/);
  assert.doesNotMatch(html, /pmStudio - Source/);
  for (const label of ["View in Pulse", "View in Activity", "Undo Publication"]) assert.ok(html.includes(label));
  assert.doesNotMatch(html, /Metric details|Publication receipt/);
});

test("Pulse landing link lowercases the site content URL and rejects non-web protocols", () => {
  assert.equal(pulseSiteUrl("https://tableau.example/", "sales & ops"), "https://tableau.example/pulse/site/sales%20%26%20ops");
  assert.equal(pulseSiteUrl("https://prod-uswest-c.online.tableau.com/", "PaCe"), "https://prod-uswest-c.online.tableau.com/pulse/site/pace");
  assert.throws(() => pulseSiteUrl("file:///tmp/tableau", "sales"), /Unsupported/);
});

test("a successful publication without a digest does not warn about unrequested follow work", () => {
  const result = receipt();
  result.follow = { version: 1, requested: false, group: { status: "not_attempted" }, membership: { status: "not_attempted" }, subscriptions: [] };
  const render = () => renderToStaticMarkup(<PublicationResult receipt={result} onClose={() => {}} onActivity={() => {}} />);
  assert.doesNotMatch(render(), /Digest setup needs attention/);
  result.follow.requested = true;
  assert.match(render(), /Digest setup needs attention/);
});

test("receipt-owned undo failures and uncertainty remain visible without a transport error", () => {
  const result = receipt();
  result.items[0].undoStatus = "failed";
  result.items[0].undoDiagnostic = { code: "403004", message: "You cannot delete this definition." };
  result.items.push({ ...result.items[0], itemIndex: 1, name: "Profit", undoStatus: "unknown", undoDiagnostic: { status: 503, message: "Tableau did not confirm deletion." } });
  const html = renderToStaticMarkup(<PublicationResult receipt={result} onClose={() => {}} onActivity={() => {}} />);
  assert.match(html, /Undo failed\. 403004: You cannot delete this definition\./);
  assert.match(html, /Undo is unconfirmed\. 503: Tableau did not confirm deletion\. Check Tableau before retrying\./);
  assert.doesNotMatch(html, /metric removed/);
});

test("receipt-owned group deletion failures and uncertainty show their messages", () => {
  for (const status of ["failed", "unknown"] as const) {
    const result = receipt();
    result.follow.group = { status: "created", id: "group", deletion: { status, message: "403010: The group cannot be deleted." } };
    const html = renderToStaticMarkup(<PublicationResult receipt={result} onClose={() => {}} onActivity={() => {}} />);
    assert.match(html, /403010: The group cannot be deleted\./);
    assert.ok(html.includes(status === "failed" ? "Group deletion failed." : "Group deletion is unconfirmed."));
    if (status === "unknown") assert.match(html, /Check Tableau before retrying\./);
    assert.doesNotMatch(html, />Group deleted</);
  }
});

test("counts include variants and retain a visible partial inventory distinction", () => {
  const snapshot = inventory();
  snapshot.definitions[0].metrics.push({ ...snapshot.definitions[0].metrics[0], metricId: "variant" });
  assert.deepEqual(inventoryCounts(snapshot), { definitions: 1, metrics: 2, partial: false });
  snapshot.definitions[0].inventoryStatus = "partial";
  assert.equal(inventoryCounts(snapshot).partial, true);
});

test("description editors reserve two lines independent of focus and retain compact cells", () => {
  const css = readFileSync(new URL("../workflows.css", import.meta.url), "utf8");
  const editor = [...css.matchAll(/\.pulse-metric-list textarea \{([^}]+)\}/g)].at(-1)?.[1];
  assert.ok(editor);
  assert.match(editor, /height: 36px/);
  assert.match(editor, /padding: 1px 6px/);
  assert.match(editor, /line-height: 16px/);
  assert.match(editor, /scrollbar-gutter: stable/);
  assert.match(css, /\.pulse-metric-list td\.pulse-description-cell \{ padding-block: 2px; \}/);
});
