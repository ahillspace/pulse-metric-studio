import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConfirmUndo, undoTargets } from "./ConfirmUndo";
import { BusyLabel } from "../components/ui";
import { receipt } from "../testing/fixtures";

test("undo confirmation names only the metrics the undo would delete", () => {
  const result = receipt();
  result.items.push({ ...result.items[0], itemIndex: 1, name: "Profit", creationStatus: "not_created" });
  result.items.push({ ...result.items[0], itemIndex: 2, name: "Removed", undoStatus: "deleted" });
  assert.deepEqual(undoTargets(result).map((item) => item.name), [result.items[0].name]);
  const html = renderToStaticMarkup(
    <ConfirmUndo receipt={result} busy={false} disabled={false} onCancel={() => {}} onConfirm={() => {}} />,
  );
  assert.match(html, /Undo publication\?/);
  assert.ok(html.includes(result.items[0].name));
  assert.doesNotMatch(html, /Profit|Removed/);
  assert.match(html, /This cannot be undone\./);
});

test("busy labels keep both labels in place and hide the inactive one", () => {
  const idle = renderToStaticMarkup(<BusyLabel busy={false} idle="Delete group" active="Deleting..." />);
  assert.match(idle, /<span>Delete group<\/span><span aria-hidden="true">Deleting\.\.\.<\/span>/);
  const busy = renderToStaticMarkup(<BusyLabel busy idle="Delete group" active="Deleting..." />);
  assert.match(busy, /<span aria-hidden="true">Delete group<\/span><span>Deleting\.\.\.<\/span>/);
});

test("a running undo Tableau limits shows its progress and Cancel in the confirmation", () => {
  const job = { kind: "undo" as const, total: 3, completed: 1, throttled: true, retryAt: 60_000, serverTime: 0, stopping: false, cancelling: false, cancelError: null, stopReason: null };
  const render = (busy: boolean, value: typeof job) => renderToStaticMarkup(
    <ConfirmUndo receipt={receipt()} busy={busy} disabled={busy} job={value} onCancelJob={() => {}} onCancel={() => {}} onConfirm={() => {}} />,
  ).replace(/<[^>]+>/g, " ");
  const running = render(true, job);
  assert.match(running, /1 of 3 done\.\s+Waiting for Tableau to accept more changes\./);
  assert.match(running, /Cancel remaining/);
  assert.match(render(true, { ...job, stopping: true }), /Stopping\.\.\./);
  assert.doesNotMatch(render(true, { ...job, throttled: false }), /Cancel remaining/, "an undo Tableau never limits shows no progress");
  assert.doesNotMatch(render(false, job), /Cancel remaining/, "another receipt's job is not shown before this undo starts");
});
