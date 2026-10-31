import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReceiptActions, SelectedReceiptActions } from "./ReceiptActions";
import { receipt, session } from "../testing/fixtures";
import { useConnection } from "../connections/controller";
import { useActivity } from "./controller";

test("selected publication toolbar hides without selection and names datasource and time", () => {
  assert.equal(renderToStaticMarkup(<SelectedReceiptActions receipt={null} />), "");
  const result = receipt();
  result.datasourceName = "Sales warehouse";
  const html = renderToStaticMarkup(<SelectedReceiptActions receipt={result} />);
  assert.match(html, /aria-label="Selected publication actions"/);
  assert.match(html, /Sales warehouse/);
  assert.ok(html.includes(new Date(result.createdAt).toISOString()));
  assert.ok(html.includes(new Date(result.createdAt).toLocaleString()));
  assert.match(html, /Undo publication/);
  assert.doesNotMatch(html, /Refresh results/);
});

test("undo action retains eligibility and failed or unknown retry visibility", () => {
  const result = receipt();
  const render = () => renderToStaticMarkup(<ReceiptActions receipt={result} />);
  assert.match(render(), /Undo publication/);
  result.undoEligible = false;
  assert.doesNotMatch(render(), /Undo publication/);
  for (const status of ["failed", "unknown"] as const) {
    result.items[0].undoStatus = status;
    assert.match(render(), /Undo publication/);
  }
  result.items[0].undoStatus = "deleted";
  assert.doesNotMatch(render(), /Undo publication/);
});

test("group deletion requires a created group ID and excludes already deleted groups", () => {
  const result = receipt();
  const render = () => renderToStaticMarkup(<ReceiptActions receipt={result} />);
  result.follow.group = { status: "reused", id: "existing", name: "Existing team" };
  assert.doesNotMatch(render(), /Delete &quot;/);
  result.follow.group = { status: "created", name: "Sales team" };
  assert.doesNotMatch(render(), /Delete &quot;/);
  result.follow.group.id = "created-group";
  assert.match(render(), /Delete &quot;Sales team&quot; Group/);
  result.follow.group.deletion = { status: "unknown", message: "Response was lost." };
  assert.match(render(), /Delete &quot;Sales team&quot; Group/);
  assert.match(render(), /Group deletion is unconfirmed\. Check Tableau before retrying\./);
  assert.match(render(), /Response was lost\./);
  result.follow.group.deletion = { status: "deleted" };
  assert.doesNotMatch(render(), /Delete &quot;/);
  assert.match(render(), /Group deleted/);
});

test("disconnected receipt actions stay disabled and explain original connection requirements", () => {
  const result = receipt();
  result.follow.group = { status: "created", id: "group", name: "Sales team" };
  const render = () => renderToStaticMarkup(<ReceiptActions receipt={result} />);
  assert.equal((render().match(/<button[^>]*disabled=""/g) || []).length, 2);
  assert.match(render(), /Connect to this publication&#x27;s Tableau site to undo\./);
  result.context = null;
  assert.match(render(), /The original Tableau connection is unknown\./);
  assert.equal((render().match(/<button[^>]*disabled=""/g) || []).length, 2);
});

test("connected actions independently block undo, group deletion, and publishing and recover when idle", (t) => {
  const originalConnection = useConnection.getState();
  const originalActivity = useActivity.getState();
  t.after(() => {
    useConnection.setState(originalConnection, true);
    useActivity.setState(originalActivity, true);
  });
  // SSR normally reads Zustand's initial snapshot. Read the current snapshot here
  // so these render assertions exercise the real stores after each state change.
  t.mock.method(React, "useSyncExternalStore", <T,>(_subscribe: unknown, getSnapshot: () => T) => getSnapshot());
  useConnection.setState({ session });
  useActivity.setState({ undoBusy: false, groupBusy: false });
  const result = receipt();
  result.follow.group = { status: "created", id: "group", name: "Sales team" };
  const assertButtons = (disabled: boolean) => {
    const html = renderToStaticMarkup(<ReceiptActions receipt={result} />);
    const buttons = html.match(/<button\b[^>]*>/g) ?? [];
    assert.equal(buttons.length, 2, "both eligible actions must be present");
    for (const button of buttons) assert.equal(button.includes('disabled=""'), disabled, button);
    assert.doesNotMatch(html, /Connect to this publication|connection is unknown/);
  };
  assertButtons(false);
  for (const owner of [result.id, "another-receipt"]) {
    useActivity.setState({ undoBusy: true, undoReceiptId: owner });
    assertButtons(true);
    useActivity.setState({ undoBusy: false });
    assertButtons(false);
    useActivity.setState({ groupBusy: true, groupReceiptId: owner });
    assertButtons(true);
    useActivity.setState({ groupBusy: false });
    assertButtons(false);
  }
  result.publishing = true;
  assertButtons(true);
  result.publishing = false;
  assertButtons(false);
});

