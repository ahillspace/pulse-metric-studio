import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConfirmGroupDeletion } from "./ConfirmGroupDeletion";

const job = { kind: "group_delete" as const, total: 1, completed: 0, throttled: true, retryAt: 60_000, serverTime: 0, stopping: false, cancelling: false, cancelError: null, stopReason: null };
const render = (props: Partial<React.ComponentProps<typeof ConfirmGroupDeletion>>) => renderToStaticMarkup(
  <ConfirmGroupDeletion name="Sales team" busy={false} deleting={false} disabled={false} onCancel={() => {}} onConfirm={() => {}} {...props} />,
);
const text = (props: Partial<React.ComponentProps<typeof ConfirmGroupDeletion>>) => render(props).replace(/<[^>]+>/g, " ");

test("group deletion confirmation names the group and says metrics remain", () => {
  const html = text({});
  assert.match(html, /Delete &quot;Sales team&quot; group\?/);
  assert.match(html, /Metrics remain\./);
  assert.match(html, /This cannot be undone\./);
  assert.doesNotMatch(html, /Cancel remaining/);
});

test("a group deletion Tableau limits shows its progress and Cancel in the confirmation", () => {
  const running = text({ busy: true, deleting: true, job });
  assert.match(running, /0 of 1 done\.\s+Waiting for Tableau to accept more changes\./);
  assert.match(running, /Cancel remaining/);
  assert.match(running, /Deleting\.\.\./);
  assert.doesNotMatch(text({ busy: true, deleting: true, job: { ...job, throttled: false } }), /Cancel remaining/, "a deletion Tableau never limits shows no progress");
  assert.doesNotMatch(text({ busy: true, deleting: false, job }), /Cancel remaining/, "another change's job is not shown here");
  assert.equal((render({ busy: true, deleting: true, job }).match(/<button[^>]*disabled=""/g) ?? []).length, 2, "the dialog's own buttons stay disabled while deleting");
});
