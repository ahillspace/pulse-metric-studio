import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import React, { type ReactElement, type ReactNode } from "react";
import * as NodeModule from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import { DigestSettings } from "./DigestSettings";
import { createAuthorController, useAuthor } from "./controller";
import { useConnection } from "../connections/controller";
import { PublicationResult } from "./PublicationResult";
import { PublishSection } from "../components/PublishSection";
import { ConfigEditor, DimensionMetricRows, selectConfigEditor } from "../components/ConfigEditor";
import { shallow } from "zustand/shallow";
import { catalog, draft, field, receipt, session } from "../testing/fixtures";

// The production receipt imports its stylesheet; this offline renderer needs no CSS loader.
const css = (NodeModule as any).registerHooks({ load(url: string, context: unknown, nextLoad: (url: string, context: unknown) => unknown) {
  return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : nextLoad(url, context);
} });
const { Receipt } = await import("../activity/Receipt");
css.deregister();

function button(node: ReactNode, label: string): ReactElement<any> | undefined {
  if (!React.isValidElement(node)) return;
  const element = node as ReactElement<any>;
  if (element.type === "button" && element.props.children === label) return element;
  for (const child of React.Children.toArray(element.props.children)) {
    const found = button(child, label); if (found) return found;
  }
}
async function setup(t: TestContext, mode: "self" | "group" | "none", access?: "allowed" | "denied" | "unknown") {
  const originalAuthor = useAuthor.getState(); const originalConnection = useConnection.getState();
  t.after(() => { useAuthor.setState(originalAuthor, true); useConnection.setState(originalConnection, true); });
  t.mock.method(React, "useSyncExternalStore", <T,>(_subscribe: unknown, getSnapshot: () => T) => getSnapshot());
  const record = draft();
  const local = createAuthorController({ readDraft: async () => record } as any, async () => ({ catalog: catalog() }), () => session);
  t.after(() => local.getState().dispose()); await local.getState().openDraft(record.id);
  const entry = local.getState().entries[record.id];
  useAuthor.setState({ activeId: record.id, entries: { [record.id]: { ...entry,
    document: { ...entry.document, followMode: mode, digestAudience: "Saved audience", digestAudienceLocked: true } as any } } });
  useConnection.setState({ session: { ...session, ...(access ? { groupCreation: { state: access, reasonCode: "test", message: access === "denied" ? "This account cannot create groups." : "Group permission is not verified." } } : {}) } as any });
  let tree: ReactElement | null | undefined;
  function Capture() { tree = DigestSettings(); return tree; }
  const html = renderToStaticMarkup(<Capture />);
  return { html, tree: tree! };
}

for (const access of ["denied", "unknown", undefined] as const) {
  test(`group choice preserves saved intent but is disabled with honest ${access ?? "missing"} access`, async (t) => {
    const { tree, html } = await setup(t, "group", access);
    assert.equal(button(tree, "Digest group")?.props.disabled, true);
    assert.equal(button(tree, "Digest group")?.props["aria-pressed"], true);
    assert.equal(Boolean(button(tree, "Follow me")?.props.disabled), false);
    assert.equal(Boolean(button(tree, "No follow")?.props.disabled), false);
    assert.match(html, access === "denied" ? /cannot create groups/ : /not verified/);
    assert.equal(useAuthor.getState().entries.a.document.digestAudience, "Saved audience");
  });
}

test("Follow me is an explicit publication setting and permitted group controls stay available", async (t) => {
  const { tree, html } = await setup(t, "self", "allowed");
  assert.equal(button(tree, "Follow me")?.props["aria-pressed"], true);
  assert.equal(Boolean(button(tree, "Digest group")?.props.disabled), false);
  assert.match(html, /connected Tableau account/);
  const chosen: string[] = [];
  useAuthor.setState({ setFollowMode: (mode: string) => chosen.push(mode) } as any);
  button(tree, "No follow")!.props.onClick();
  assert.deepEqual(chosen, ["none"]);
});

test("permission retry delegates only to the access-only refresh", async (t) => {
  await setup(t, "group", "unknown");
  let retries = 0;
  useConnection.setState({ refreshAccess: async () => { retries++; } });
  let tree: ReactElement | null | undefined;
  function Capture() { tree = DigestSettings(); return tree; }
  renderToStaticMarkup(<Capture />);
  button(tree!, "Check permissions")!.props.onClick();
  assert.equal(retries, 1);
  assert.equal(useAuthor.getState().entries.a.document.followMode, "group");
});

test("self-follow results and Activity name the captured publisher and retain partial outcomes", () => {
  const result = receipt();
  result.follow = { ...result.follow, mode: "self", requested: true, selfRecipient: { id: "publisher", name: "Publishing account" },
    group: { status: "not_attempted" }, membership: { status: "not_attempted" },
    subscriptions: [{ itemIndex: 0, metricId: "metric", status: "unknown", error: "The follow outcome is unconfirmed. Check Tableau before retrying." }] } as any;
  for (const html of [renderToStaticMarkup(<PublicationResult receipt={result} onClose={() => {}} onActivity={() => {}} />), renderToStaticMarkup(<Receipt receipt={result} showActions={false} />)]) {
    assert.match(html, /Publishing account/);
    assert.match(html, /unconfirmed|Unconfirmed/);
    assert.doesNotMatch(html, /Digest setup|Your membership|Digest group/);
  }
});

const receiptRenderers = {
  PublicationResult: (result: ReturnType<typeof receipt>) => renderToStaticMarkup(<PublicationResult receipt={result} onClose={() => {}} onActivity={() => {}} />),
  Activity: (result: ReturnType<typeof receipt>) => renderToStaticMarkup(<Receipt receipt={result} showActions={false} />),
};

for (const [renderer, render] of Object.entries(receiptRenderers)) {
  test(`${renderer} does not warn for successful serialized self-follow with unattempted group stages`, () => {
    const result = receipt();
    // Serialized backend shape: emptyFollowReceipt leaves inapplicable group stages not_attempted.
    result.follow = JSON.parse('{"version":1,"mode":"self","requested":true,"selfRecipient":{"id":"publisher"},"group":{"status":"not_attempted"},"membership":{"status":"not_attempted"},"subscriptions":[{"itemIndex":0,"metricId":"metric","status":"created"}]}');
    const html = render(result);
    assert.match(html, /Personal follow|Personal follow target/);
    assert.doesNotMatch(html, /needs attention|Digest setup|Your membership/);
  });

  for (const status of ["failed", "unknown", "not_attempted"] as const) {
    test(`${renderer} still warns for a ${status} personal subscription`, () => {
      const result = receipt();
      result.follow = { version: 1, mode: "self", requested: true, selfRecipient: { id: "publisher" },
        group: { status: "not_attempted" }, membership: { status: "not_attempted" },
        subscriptions: [{ itemIndex: 0, metricId: "metric", status, error: "Personal subscription requires inspection." }] };
      const html = render(result);
      assert.match(html, /Personal follow(?: -)? needs attention/);
      assert.match(html, /Personal subscription requires inspection/);
      if (status === "unknown" && renderer === "Activity") assert.match(html, /Unconfirmed/);
    });
  }

  test(`${renderer} retains group-stage attention and ignores unrequested none stages`, () => {
    const result = receipt();
    result.follow = { version: 1, mode: "group", requested: true, group: { status: "not_attempted" }, membership: { status: "not_attempted" },
      subscriptions: [{ itemIndex: 0, metricId: "metric", status: "created" }] };
    assert.match(render(result), /(?:Digest setup|Digest group -) needs attention/);
    result.follow.mode = "none"; result.follow.requested = false;
    assert.doesNotMatch(render(result), /needs attention/);
  });
}

for (const mode of ["self", "group", "none"] as const) {
  test(`publication review states ${mode} intent and the captured self target`, async (t) => {
    await setup(t, mode, mode === "group" ? "denied" : "unknown");
    const entry = useAuthor.getState().entries.a;
    useAuthor.setState({ entries: { a: { ...entry, previewSequence: entry.sequence, preview: {
      draftId: "a", revision: entry.record.revision, context: entry.record.context, datasourceName: "A", previewFingerprint: "reviewed",
      metrics: [{ ...receipt().items[0].summary, name: "Revenue", description: "" }], digestAudience: "Saved audience", followMode: mode,
      ...(mode === "self" ? { selfRecipient: { id: "publisher-id", name: "Captured publisher" } } : {}), issues: [],
    } } } });
    const hidden = renderToStaticMarkup(<PublishSection visible={false} onActivity={() => {}} />);
    assert.doesNotMatch(hidden, /aria-label="Publish reviewed draft"/);
    assert.ok(useAuthor.getState().entries.a.preview, "navigation retains the reviewed preview");
    Object.defineProperty(globalThis, "document", { value: { getElementById: () => null }, configurable: true });
    t.after(() => { Reflect.deleteProperty(globalThis, "document"); });
    const html = renderToStaticMarkup(<PublishSection visible onActivity={() => {}} />);
    const submit = html.match(/<button[^>]*aria-label="Publish reviewed draft"[^>]*>/)?.[0];
    assert.ok(submit);
    assert.equal(submit.includes('disabled=""'), mode === "group", "unverified group permission cannot block personal or unfollowed publication");
    if (mode === "self") assert.match(html, /Follow these metrics as Captured publisher/);
    if (mode === "group") assert.match(html, /Digest group requested for Saved audience/);
    if (mode === "none") assert.match(html, /Publish these metrics without following them/);
  });
}

test("closed dimension settings do not build metric rows for a large catalog", async (t) => {
  await setup(t, "self");
  const entry = useAuthor.getState().entries.a;
  const dimensions = Array.from({ length: 1000 }, (_, index) => field(`dimension-${index}`, "STRING"));
  useAuthor.setState({ entries: { a: { ...entry, catalog: { ...entry.catalog!, dimensions } } } });
  const html = renderToStaticMarkup(<ConfigEditor />);
  const details = html.slice(html.indexOf('<details class="pulse-dimension-group"'));
  assert.doesNotMatch(details, /dimension-0/);
  assert.match(details, /Dimensions <span>1000<\/span>/);
});

test("composer changes do not invalidate the configuration editor selection", async (t) => {
  await setup(t, "self");
  const before = selectConfigEditor(useAuthor.getState());
  useAuthor.getState().setComposer("A new request");
  const after = selectConfigEditor(useAuthor.getState());
  assert.ok(shallow(before, after));
  const entry = useAuthor.getState().entries.a;
  useAuthor.setState({ entries: { a: { ...entry, document: { ...entry.document, digestAudience: "Changed" } } } });
  assert.equal(shallow(after, selectConfigEditor(useAuthor.getState())), false);
});

test("expanded dimension settings render only the selected page", () => {
  const fields = Array.from({ length: 120 }, (_, index) => ({ id: `dimension-${index}`, label: `dimension-${index}`, dimension: true, field: field(`dimension-${index}`, "STRING") }));
  const html = renderToStaticMarkup(<DimensionMetricRows fields={fields} page={1} onPageChange={() => {}} metrics={{}} catalog={catalog()} onToggle={() => {}} onChange={() => {}} />);
  assert.match(html, /dimension-50/);
  assert.match(html, /dimension-99/);
  assert.doesNotMatch(html, /dimension-100/);
  assert.match(html, /51-100 of 120 dimensions/);
});

test("publication and Activity retain actionable messages with optional backend diagnostic detail", () => {
  const result = receipt();
  result.createdCount = 0; result.failedCount = 1;
  result.items[0].creationStatus = "not_created";
  result.items[0].diagnostic = { message: "This definition already exists. Review it before publishing again.", status: 409,
    providerCode: "409-example", detail: "Sanitized provider detail <example>" };
  for (const html of [renderToStaticMarkup(<PublicationResult receipt={result} onClose={() => {}} onActivity={() => {}} />), renderToStaticMarkup(<Receipt receipt={result} showActions={false} />)]) {
    assert.match(html, /This definition already exists\. Review it before publishing again\./);
    assert.match(html, /<summary>Tableau details<\/summary>/);
    assert.match(html, /409-example/);
    assert.match(html, /Sanitized provider detail &lt;example&gt;/);
  }
});
