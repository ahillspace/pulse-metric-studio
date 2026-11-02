import assert from "node:assert/strict";
import test from "node:test";
import React, { type ReactElement, type ReactNode } from "react";
import { VariantDialog } from "./VariantDialog";

function primary(node: ReactNode): ReactElement<any> | undefined {
  if (!React.isValidElement(node)) return;
  const element = node as ReactElement<any>;
  if (element.type === "button" && element.props.className === "btn primary") return element;
  for (const child of React.Children.toArray(element.props.children)) {
    const found = primary(child);
    if (found) return found;
  }
}

test("variant controls use the workspace dialog host and recover after closing is canceled", (t) => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const host = { nodeType: 1 };
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    getElementById: (id: string) => id === "pulse-workspace-dialogs" ? host : null,
    body: { nodeType: 1 },
  } });
  const dispatcher = (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher;
  const originalDispatcher = dispatcher.current;
  t.after(() => {
    dispatcher.current = originalDispatcher;
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
  });
  for (const busy of [true, false]) {
    let state = 0;
    dispatcher.current = {
      useState(initial: unknown) {
        let value = typeof initial === "function" ? (initial as () => any)() : initial;
        if (state++ === 0) value = { ...value as object, timeframe: { key: "MTD", label: "Month to date" } };
        return [value, () => {}];
      },
      useMemo: (factory: () => unknown) => factory(),
      useCallback: (callback: unknown) => callback,
      useRef: (current: unknown) => ({ current }),
      useEffect() {},
    };
    const portal = VariantDialog({
      metrics: [{ metricId: "metric", definitionId: "definition", name: "Revenue", timeframeLabel: "Year to date", measurementPeriod: {} }],
      selectedMetricIds: ["metric"], busy, onClose() {}, onCreate: async () => {},
    }) as any;
    assert.equal(portal.containerInfo, host);
    assert.equal(portal.children.props.children.props.disabled, busy);
    assert.equal(primary(portal.children.props.actions)?.props.disabled, busy);
  }
});
