import {
  emptyPulseDocument,
  defaultPulseMetric,
  type CatalogField,
  type DatasourceCatalog,
  type PulseDraftRecord,
  type PulsePublishReceipt,
  type PulseInventoryResponse,
} from "@pulse-metric-studio/shared";

export const session = {
  connectionId: "connection",
  sessionGeneration: 1,
  serverUrl: "https://tableau.example",
  siteId: "site",
  siteContentUrl: "sales",
  userId: "user",
};
export const field = (id: string, dataType = "REAL"): CatalogField => ({
  id,
  name: id,
  caption: id,
  label: id,
  role: dataType === "REAL" ? "MEASURE" : "DIMENSION",
  dataType,
  table: "Orders",
  defaultAggregation: "SUM",
  formula: null,
  requiresUserAgg: false,
});
export function catalog(id = "a"): DatasourceCatalog {
  return {
    datasourceLuid: id,
    datasourceName: id,
    measures: [field("Sales")],
    dimensions: [field("Region", "STRING")],
    timeDimensions: [
      { ...field("Order Date", "DATE"), timeType: "DATE" },
      { ...field("Ship Date", "DATE"), timeType: "DATE" },
    ],
    parameters: [],
    excluded: [],
    source: "vds",
    warnings: [],
  };
}
export function draft(id = "a"): PulseDraftRecord {
  const document = emptyPulseDocument();
  document.metrics.Sales = defaultPulseMetric(catalog(id), "Sales")!;
  document.slicers.Region = {
    active: true,
    fieldId: "Region",
    fieldLabel: "Region",
  };
  return {
    id,
    context: {
      connectionId: session.connectionId,
      serverUrl: session.serverUrl,
      siteId: session.siteId,
      datasourceLuid: id,
    },
    datasourceName: id.toUpperCase(),
    schemaVersion: 1,
    revision: 1,
    document,
    updatedAt: 1,
  };
}
export function receipt(id = "receipt"): PulsePublishReceipt {
  return {
    id,
    context: draft().context,
    connectionId: session.connectionId,
    datasourceLuid: "a",
    datasourceName: "A",
    createdAt: 1,
    finishedAt: 2,
    publishing: false,
    interrupted: false,
    items: [
      {
        itemIndex: 0,
        name: "Sales",
        summary: {
          version: 1,
          fieldId: "Sales",
          fieldLabel: "Sales",
          aggregation: "SUM",
          timeDimensionFieldId: "Order Date",
          timeDimensionLabel: "Order Date",
          temporality: "OVER_TIME",
          cumulative: false,
          slicers: [],
        },
        definitionId: "definition",
        metricId: "metric",
        creationStatus: "created",
        resolutionStatus: "resolved",
        diagnostic: null,
        undoStatus: "pending",
        undoDiagnostic: null,
      },
    ],
    follow: {
      version: 1,
      requested: false,
      group: { status: "skipped" },
      membership: { status: "skipped" },
      subscriptions: [],
    },
    createdCount: 1,
    unknownCount: 0,
    failedCount: 0,
    unattemptedCount: 0,
    undoEligible: true,
  };
}
export function inventory(id = "metric"): PulseInventoryResponse {
  return {
    definitions: [
      {
        definitionId: `definition-${id}`,
        name: id,
        description: "",
        measure: "Sales",
        aggregation: "SUM",
        timeDimension: "Order Date",
        inventoryStatus: "complete",
        metrics: [
          {
            metricId: id,
            name: id,
            measurementPeriod: {},
            timeframeLabel: "Month to date",
            filters: [],
            comparison: null,
            specification: {},
            isDefault: false,
            isScoped: false,
            scopedState: "variant",
          },
        ],
      },
    ],
    totalScanned: 1,
    truncated: false,
    failures: [],
  };
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
