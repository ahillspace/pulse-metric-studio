import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RegistryResultsModal } from "./views";
import type { RegistryActionResults } from "../registry-actions";

test("explicit command results show bounded distinct backend explanations without opening detail", () => {
  const reasons = ["A metric already uses this definition. Review it before publishing again.",
    "Tableau asked you to wait. Try this operation later.", "This account cannot change the selected metric.", "Inspect Tableau before retrying this unconfirmed request."];
  const results: RegistryActionResults = { kind: "follow", title: "Follow results", finishedAt: 1,
    items: [...reasons, reasons[0]].map((detail, index) => ({ key: String(index), metricId: String(index), metricLabel: `Metric ${index}`,
      status: index === 3 ? "unknown" : "failed", detail })) };
  const html = renderToStaticMarkup(<RegistryResultsModal results={results} onDismiss={() => {}} />);
  const primary = html.slice(0, html.indexOf('<details'));
  for (const reason of reasons.slice(0, 3)) assert.ok(primary.includes(reason));
  assert.equal(primary.split(reasons[0]).length - 1, 1);
  assert.match(primary, /1 more reason/);
  assert.ok(html.includes(reasons[3]), "the complete per-metric outcome remains inspectable");
  assert.match(html, /outcome unknown/);
});

test("long duplicate explanations are bounded in the summary while full outcomes remain", () => {
  const detail = `Provider explanation: ${"x".repeat(900)}`;
  const results: RegistryActionResults = { kind: "delete", title: "Delete results", finishedAt: 1,
    items: [0, 1].map(index => ({ key: String(index), metricId: String(index), metricLabel: `Metric ${index}`, status: "unknown", detail })) };
  const html = renderToStaticMarkup(<RegistryResultsModal results={results} onDismiss={() => {}} />);
  const primary = html.slice(0, html.indexOf('<details'));
  assert.equal(primary.split("Provider explanation:").length - 1, 1);
  assert.ok(primary.includes("..."));
  assert.ok(!primary.includes("x".repeat(301)));
  assert.ok(html.includes(detail));
  assert.match(html, /outcome unknown/);
});
