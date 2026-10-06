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
