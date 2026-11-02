import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { catalog, draft } from "../testing/fixtures";
import { MetricTable } from "./MetricTable";
import { ProposalReview } from "./ProposalReview";
import type { DraftEditor } from "./controller";
import { summarizeProposal } from "./proposal-summary";
import { clampAssistantWidth } from "../shell/ResizableAssistant";
import {
  filterDatasourceChoices,
  datasourcePopoverLayout,
  resolveDatasourceListKey,
} from "../datasource-picker-actions";

test("slicer selection keeps font weight stable despite later legacy active styles", () => {
  const css = readFileSync(new URL("../workflows.css", import.meta.url), "utf8");
  const chip = css.match(/\.pulse-app \.pill \{([^}]+)\}/)?.[1];
  assert.ok(chip);
  assert.match(chip, /max-width:\s*100%;/);
  assert.match(chip, /white-space:\s*nowrap;/);
  assert.match(chip, /text-overflow:\s*ellipsis;/);
  for (const state of ["active", "inactive"]) {
    const declaration = css.match(new RegExp(`\\.pulse-app \\.pill\\.${state} \\{([^}]+)\\}`))?.[1];
    assert.ok(declaration, `Explicit higher-specificity ${state} selector`);
    assert.match(declaration, /font-weight:\s*400\s*;/);
  }
});

test("long source names stay on one line with space reserved for metadata access", () => {
  const css = readFileSync(new URL("../workflows.css", import.meta.url), "utf8");
  const declaration = css.match(/\.pulse-source-field-name \{([^}]+)\}/)?.[1];
  const labelWrapper = css.match(/\.pulse-source-field-label \{([^}]+)\}/)?.[1];
  assert.ok(declaration);
  assert.ok(labelWrapper);
  assert.match(labelWrapper, /display:\s*inline-flex;/);
  assert.match(labelWrapper, /max-width:\s*calc\(100% - 32px\);/);
  assert.match(declaration, /min-width:\s*0;/);
  assert.match(declaration, /white-space:\s*nowrap;/);
  assert.match(declaration, /text-overflow:\s*ellipsis;/);
  const label = "Closed Opportunity Monthly Goal for Enterprise Customers Across All Regions";
  const markup = renderToStaticMarkup(
    <MetricTable fields={[{ id: "Sales", label, dimension: false }]} metrics={{}} catalog={null} onToggle={() => {}} onChange={() => {}} />,
  );
  assert.ok(markup.includes(`<span class="pulse-source-field-name" title="${label}">${label}</span>`));
  assert.ok(markup.includes(`aria-label="Field details for ${label}"`));
});

test("all available datasources remain browsable without a search, including beyond sixty", () => {
  const sources = Array.from({ length: 150 }, (_, index) => ({
    name: `Source ${index + 1}`,
    projectName: "Sales",
    luid: String(index),
  }));
  assert.equal(filterDatasourceChoices(sources, "").length, 150);
  assert.equal(filterDatasourceChoices(sources, " ").length, 150);
  assert.deepEqual(resolveDatasourceListKey("End", 0, sources.length), {
    type: "move",
    index: 149,
  });
  assert.equal(filterDatasourceChoices(sources, "Source 150")[0].luid, "149");
  assert.equal(filterDatasourceChoices(sources, "sales").length, 150);
});

test("metric settings are inline, with labeled controls and a keyboard-focusable horizontal region", () => {
  const source = catalog();
  const record = draft();
  const markup = renderToStaticMarkup(
    <MetricTable
      fields={[
        {
          id: "Sales",
          label: "Sales",
          dimension: false,
          field: source.measures[0],
        },
      ]}
      metrics={record.document.metrics}
      catalog={source}
      onToggle={() => {}}
      onChange={() => {}}
    />,
  );
  for (const label of [
    "Metric name",
    "Aggregation",
    "Time field",
    "Description",
    "Format",
    "Sentiment",
    "Data mode",
    "Cumulative",
    "Minimum granularity",
  ]) {
    assert.ok(markup.includes(`aria-label="${label} for Sales"`), label);
  }
  assert.match(markup, /tabindex="0" role="region"/);
  assert.match(markup, /Source field/);
  assert.doesNotMatch(markup, /role="dialog"/);
});

test("metric columns put core settings before description and display source names directly", () => {
  const source = catalog();
  const record = draft();
  record.document.metrics.Sales.name = "Revenue";
  record.document.metrics.Sales.locks = ["name"];
  source.measures[0].formula = "SUM([Sales])";
  const markup = renderToStaticMarkup(
    <MetricTable
      fields={[{ id: "Sales", label: "Sales", dimension: false, field: source.measures[0] }]}
      metrics={record.document.metrics}
      catalog={source}
      onToggle={() => {}}
      onChange={() => {}}
    />,
  );
  const headings = [...markup.matchAll(/<th scope="col">([^<]+)<\/th>/g)].map((match) => match[1]);
  assert.deepEqual(headings, [
    "Metric", "Calculation", "Date field", "Format", "Sentiment", "Data mode",
    "Cumulative", "Minimum granularity", "Description", "Source field",
  ]);
  assert.match(markup, /value="Revenue"/);
  assert.match(markup, /<span class="pulse-source-field-name" title="Sales">Sales<\/span><\/span><details/);
  assert.match(markup, /aria-label="Field details for Sales"/);
  assert.match(markup, /SUM\(\[Sales\]\)/);
  assert.match(markup, /Protected from assistant changes: name/);
  assert.doesNotMatch(markup, /<small>Sales<\/small>/);
});

test("unselected and selected metrics use the same single-line name structure", () => {
  const source = catalog();
  const record = draft();
  for (const metrics of [{}, record.document.metrics]) {
    const markup = renderToStaticMarkup(
      <MetricTable
        fields={[{ id: "Sales", label: "Sales", dimension: false, field: source.measures[0] }]}
        metrics={metrics}
        catalog={source}
        onToggle={() => {}}
        onChange={() => {}}
      />,
    );
    assert.doesNotMatch(markup, /<small>/);
    assert.match(markup, /aria-label="Metric name for Sales"/);
    assert.match(markup, /<span class="pulse-source-field-name" title="Sales">Sales<\/span>/);
    assert.equal((markup.match(/<th scope="row">/g) ?? []).length, 1);
    assert.equal((markup.match(/<td(?: class="[^"]*")?>/g) ?? []).length, 9);
  }
});

test("unavailable field warning stays beside the source name without adding a metric-name line", () => {
  const markup = renderToStaticMarkup(
    <MetricTable fields={[{ id: "Sales", label: "Sales", dimension: false }]} metrics={draft().document.metrics} catalog={catalog()} onToggle={() => {}} onChange={() => {}} />,
  );
  const nameCell = markup.match(/<th scope="row">([^]*?)<\/th>/)?.[1];
  assert.ok(nameCell);
  assert.doesNotMatch(nameCell, /Unavailable/);
  assert.match(markup, /<span class="pulse-source-field-label"><span class="pulse-source-field-name" title="Sales">Sales<\/span><span class="pulse-field-unavailable">Unavailable<\/span><\/span>/);
});

test("metric summary groups added, removed, and changed measures and filters", () => {
  const before = draft().document;
  const after = structuredClone(before);
  after.metrics.Sales.name = "Revenue";
  after.metrics.Quantity = {
    ...after.metrics.Sales,
    fieldId: "Quantity",
    fieldLabel: "Quantity",
    name: "Quantity",
  };
  before.metrics.Profit = {
    ...before.metrics.Sales,
    fieldId: "Profit",
    fieldLabel: "Profit",
    name: "Profit",
  };
  after.slicers.Region.active = false;
  after.slicers.Category = {
    fieldId: "Category",
    fieldLabel: "Category",
    active: true,
  };
  assert.deepEqual(summarizeProposal(before, after), {
    measures: [
      { id: "Sales", name: "Revenue", status: "Changed" },
      { id: "Profit", name: "Profit", status: "Removed" },
      { id: "Quantity", name: "Quantity", status: "Added" },
    ],
    filters: [
      { id: "Region", name: "Region", status: "Removed" },
      { id: "Category", name: "Category", status: "Added" },
    ],
  });
  assert.deepEqual(summarizeProposal(after, structuredClone(after)), {
    measures: [],
    filters: [],
  });
});

test("assistant resizing stays within readable bounds", () => {
  assert.equal(clampAssistantWidth(50), 280);
  assert.equal(clampAssistantWidth(340), 340);
  assert.equal(clampAssistantWidth(1000), 520);
  assert.equal(clampAssistantWidth(500, 360), 360);
  assert.equal(clampAssistantWidth(340, 240), 240);
});

test("wide datasource choices remain inside a narrow viewport", () => {
  const layout = datasourcePopoverLayout(640, 170);
  assert.equal(layout.width, 490);
  assert.ok(170 + layout.left + layout.width <= 624);
  assert.ok(170 + layout.left >= 16);
  assert.equal(datasourcePopoverLayout(390, 170).width, 358);
});

test("assistant response shows an expanded grouped diff with collapsed details and resulting metrics", () => {
  const document = draft().document;
  const entry = {
    document,
    proposalBase: document,
    catalog: catalog(),
    proposal: {
      baseRevision: 1,
      candidateDocument: document,
      assistantMessage: "Review",
      changes: [],
    },
  } as unknown as DraftEditor;
  const markup = renderToStaticMarkup(<ProposalReview entry={entry} />);
  assert.match(markup, /<details open="" class="pulse-proposal-diff">/);
  assert.match(markup, /<details class="pulse-proposal-detail">/);
  assert.match(markup, /<details class="pulse-proposal-result">/);
  assert.ok(
    markup.indexOf("Measures and filters") <
      markup.indexOf("Review all changes"),
  );
  assert.ok(
    markup.indexOf("Review all changes") <
      markup.indexOf("Review resulting metrics"),
  );
});

test("protection metadata alone does not appear as a metric change", () => {
  const before = draft().document;
  const after = structuredClone(before);
  after.metrics.Sales.locks = ["name"];
  assert.deepEqual(summarizeProposal(before, after), {
    measures: [],
    filters: [],
  });
});

test("proposal review shows the same preserved manual edits that acceptance applies", () => {
  const base = draft().document;
  const candidate = structuredClone(base);
  candidate.metrics.Sales.name = "Assistant revenue";
  const current = structuredClone(base);
  current.metrics.Sales.name = "Manual revenue";
  current.metrics.Sales.locks = ["name"];
  const entry = {
    document: current,
    proposalBase: base,
    proposalEpoch: 0,
    configurationEpoch: 0,
    catalog: catalog(),
    proposal: { baseRevision: 1, candidateDocument: candidate, assistantMessage: "Renamed", changes: [] },
  } as unknown as DraftEditor;
  const markup = renderToStaticMarkup(<ProposalReview entry={entry} />);
  assert.match(markup, /Manual revenue/);
  assert.doesNotMatch(markup, /Assistant revenue/);
  assert.match(markup, /Your newer or protected edits are kept/);
  assert.match(markup, /Review all changes \(0\)/);
});
