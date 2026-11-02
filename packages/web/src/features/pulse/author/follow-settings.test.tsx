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
import { catalog, draft, receipt, session } from "../testing/fixtures";

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
    group: { status: "skipped" }, membership: { status: "skipped" },
    subscriptions: [{ itemIndex: 0, metricId: "metric", status: "unknown", error: "The follow outcome is unconfirmed. Check Tableau before retrying." }] } as any;
  for (const html of [renderToStaticMarkup(<PublicationResult receipt={result} onClose={() => {}} onActivity={() => {}} />), renderToStaticMarkup(<Receipt receipt={result} showActions={false} />)]) {
    assert.match(html, /Publishing account/);
    assert.match(html, /unconfirmed|Unconfirmed/);
    assert.doesNotMatch(html, /Digest setup|Your membership|Digest group/);
  }
});

for (const mode of ["self", "group", "none"] as const) {
  test(`publication review states ${mode} intent and the captured self target`, async (t) => {
    await setup(t, mode, mode === "group" ? "denied" : "unknown");
    const entry = useAuthor.getState().entries.a;
    useAuthor.setState({ entries: { a: { ...entry, previewSequence: entry.sequence, preview: {
      draftId: "a", revision: entry.record.revision, context: entry.record.context, datasourceName: "A", previewFingerprint: "reviewed",
      metrics: [{ ...receipt().items[0].summary, name: "Revenue", description: "" }], digestAudience: "Saved audience", followMode: mode,
      ...(mode === "self" ? { selfRecipient: { id: "publisher-id", name: "Captured publisher" } } : {}), issues: [],
    } } } });
    const html = renderToStaticMarkup(<PublishSection visible={false} onActivity={() => {}} />);
    const submit = html.match(/<button[^>]*aria-label="Publish reviewed draft"[^>]*>/)?.[0];
    assert.ok(submit);
    assert.equal(submit.includes('disabled=""'), mode === "group", "unverified group permission cannot block personal or unfollowed publication");
    if (mode === "self") assert.match(html, /Follow these metrics as Captured publisher/);
    if (mode === "group") assert.match(html, /Digest group requested for Saved audience/);
    if (mode === "none") assert.match(html, /Publish these metrics without following them/);
  });
}

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
