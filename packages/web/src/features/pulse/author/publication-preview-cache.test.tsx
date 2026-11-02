import assert from "node:assert/strict";
import test from "node:test";
import React, { type ReactElement, type ReactNode } from "react";
import { PublicationResult } from "./PublicationResult";
import { createPublishedPreviewCache, PublishedMetrics } from "./PublishedMetrics";
import { useConnection } from "../connections/controller";
import { receipt, session } from "../testing/fixtures";

function find(node: ReactNode, predicate: (element: ReactElement<any>) => boolean): ReactElement<any> | undefined {
  if (!React.isValidElement(node)) return;
  const element = node as ReactElement<any>;
  if (predicate(element)) return element;
  for (const child of [element.props.actions, ...React.Children.toArray(element.props.children)]) {
    const found = find(child, predicate);
    if (found) return found;
  }
}

test("both real publication confirmations retain preview requests when canceled", async (t) => {
  const originalConnection = useConnection.getState();
  const originalFetch = globalThis.fetch;
  t.after(() => { useConnection.setState(originalConnection, true); globalThis.fetch = originalFetch; });
  useConnection.setState({ session });
  const published = receipt();
  published.follow.group = { status: "created", id: "group", name: "Audience" };
  published.items = Array.from({ length: 3 }, (_, index) => ({ ...published.items[0], itemIndex: index, metricId: `metric-${index}` }));
  let requests = 0;
  globalThis.fetch = async (url) => {
    requests++;
    const metricId = decodeURIComponent(String(url).split("/").at(-2)!);
    return Response.json({ metricId, definitionId: "definition", name: "Revenue", imageDataUrl: "data:image/png;base64,aW1hZ2U=", generatedAt: 1 });
  };
  // Exercise the component's own hook state and event callbacks without a browser.
  const dispatcher = (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher;
  const savedDispatcher = dispatcher.current;
  t.after(() => { dispatcher.current = savedDispatcher; });
  const states: unknown[] = [];
  let index = 0;
  const render = () => {
    index = 0;
    dispatcher.current = {
      useState(initial: unknown) {
        const slot = index++;
        if (!(slot in states)) states[slot] = typeof initial === "function" ? (initial as () => unknown)() : initial;
        return [states[slot], (value: unknown) => { states[slot] = typeof value === "function" ? (value as (before: unknown) => unknown)(states[slot]) : value; }];
      },
      useSyncExternalStore(_subscribe: unknown, getSnapshot: () => unknown) { return getSnapshot(); },
      useCallback(callback: unknown) { return callback; },
      useDebugValue() {},
    };
    try { return PublicationResult({ receipt: published, onClose() {}, onActivity() {} }); }
    finally { dispatcher.current = savedDispatcher; }
  };
  const loadAutomaticCards = async (tree: ReactNode) => {
    const cards = find(tree, (element) => element.type === PublishedMetrics)!;
    assert.ok(cards, "the result subtree contains the automatic preview cards");
    await Promise.all(cards.props.items.slice(0, 3).map((item: any) =>
      cards.props.previews.load(cards.props.live.context, item.metricId, item.definitionId)));
  };
  let tree = render();
  await loadAutomaticCards(tree);
  assert.equal(requests, 3);
  const undo = find(tree, (element) => element.type === "button" && React.Children.toArray(element.props.children).some((child: any) => child?.props?.idle === "Undo Publication"))!;
  undo.props.onClick();
  const confirmation = render();
  assert.equal(find(confirmation, (element) => element.type === PublishedMetrics), undefined);
  confirmation.props.onCancel();
  tree = render();
  await loadAutomaticCards(tree);
  const group = find(tree, (element) => element.type === "button" && String(element.props.children).includes('Group'))!;
  group.props.onClick();
  render().props.onClose();
  tree = render();
  await loadAutomaticCards(tree);
  assert.equal(requests, 3, "canceling either confirmation generates no duplicate previews");
  useConnection.setState({ session: { ...session, sessionGeneration: 2 } });
  await loadAutomaticCards(render());
  assert.equal(requests, 6, "a new authenticated session regenerates previews");
});

test("publication preview cache shares pending reads, refreshes explicitly and rejects mismatched ownership", async () => {
  let requests = 0;
  const context = receipt().context!;
  const cache = createPublishedPreviewCache(async (_context, metricId) => {
    requests++;
    return { metricId, definitionId: "definition", name: "Revenue", imageDataUrl: "data:image/png;base64,aW1hZ2U=", generatedAt: requests };
  });
  cache.setScope("owner-1");
  await Promise.all([cache.load(context, "metric", "definition"), cache.load(context, "metric", "definition")]);
  assert.equal(requests, 1);
  await cache.load(context, "metric", "definition", true);
  assert.equal(requests, 2);
  cache.setScope("mutation-2");
  await cache.load(context, "metric", "definition");
  assert.equal(requests, 3);
  await assert.rejects(cache.load(context, "metric", "other-definition"), /different metric/);
});
