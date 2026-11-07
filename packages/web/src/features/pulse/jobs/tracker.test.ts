import assert from "node:assert/strict";
import test from "node:test";
import type { PulseMutationJobStatus } from "@pulse-metric-studio/shared";
import { createMutationJobTracker, stoppedMessage, type CancelMutationJob, type MutationJobProgress } from "./tracker";

function status(id: string, overrides: Partial<PulseMutationJobStatus> = {}): PulseMutationJobStatus {
  return { id, kind: "publish", state: "running", total: 4, completed: 1, throttled: true, retryAt: 60_000, serverTime: 0, stopReason: null, ...overrides };
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A tracker writing into one view's slot, as a controller store would. */
function view(cancelJob: CancelMutationJob) {
  const tracker = createMutationJobTracker(cancelJob);
  let job: MutationJobProgress | null = null;
  let showing = true;
  const begin = (total: number | null = null) => tracker.begin({ owner: null, total, current: () => showing, read: () => job, write: (next) => { job = next; } });
  return { tracker, begin, job: () => job, hide: () => { showing = false; } };
}

test("progress follows the job and offsets later requests by finished items", () => {
  const slot = view(async () => { throw new Error("No cancel expected."); });
  const run = slot.begin(10);
  run.observe(status("job-1", { completed: 2 }));
  assert.deepEqual(slot.job(), { kind: "publish", total: 10, completed: 2, throttled: true, retryAt: 60_000, serverTime: 0, stopping: false, cancelling: false, cancelError: null, stopReason: null });
  run.advance(4);
  run.observe(status("job-2", { completed: 1, throttled: false }));
  assert.equal(slot.job()?.completed, 5);
  assert.equal(slot.job()?.throttled, true, "a run Tableau limited keeps showing its progress");
  run.end();
  assert.equal(slot.job(), null);
});

test("a run without a known total shows the server's count", () => {
  const slot = view(async () => { throw new Error("No cancel expected."); });
  slot.begin().observe(status("job", { total: 7 }));
  assert.equal(slot.job()?.total, 7);
});

test("an unconfirmed cancel is reported, can be pressed again, and is not resent once confirmed", async () => {
  const cancels: string[] = [];
  let reject = true;
  const slot = view(async (id) => {
    cancels.push(id);
    if (reject) throw new Error("The desktop service is unavailable.");
    return status(id, { state: "stopping", stopReason: "cancelled" });
  });
  const run = slot.begin();
  run.observe(status("job"));
  await slot.tracker.cancel();
  assert.equal(run.cancelled, true, "the client sends no later request once Cancel is pressed");
  assert.deepEqual({ stopping: slot.job()?.stopping, cancelling: slot.job()?.cancelling }, { stopping: false, cancelling: false });
  assert.match(slot.job()?.cancelError ?? "", /^Cancel was not confirmed.*desktop service is unavailable/);
  reject = false;
  await slot.tracker.cancel();
  assert.deepEqual({ stopping: slot.job()?.stopping, cancelError: slot.job()?.cancelError, stopReason: slot.job()?.stopReason }, { stopping: true, cancelError: null, stopReason: "cancelled" });
  assert.equal(run.stopReason, "cancelled");
  await slot.tracker.cancel();
  assert.deepEqual(cancels, ["job", "job"]);
});

test("a cancel pressed before the job reports in is sent as soon as it does", async () => {
  const cancels: string[] = [];
  const slot = view(async (id) => { cancels.push(id); return status(id, { state: "stopping", stopReason: "cancelled" }); });
  const run = slot.begin();
  await slot.tracker.cancel();
  assert.deepEqual(cancels, []);
  run.observe(status("job"));
  assert.equal(slot.job()?.cancelling, true);
  await settle();
  assert.deepEqual(cancels, ["job"]);
  assert.equal(slot.job()?.stopping, true);
});

test("a cancel that reaches a finished job reports no stop", async () => {
  const slot = view(async (id) => status(id, { state: "finished" }));
  const run = slot.begin();
  run.observe(status("job"));
  await slot.tracker.cancel();
  assert.deepEqual({ stopping: slot.job()?.stopping, cancelling: slot.job()?.cancelling, stopReason: slot.job()?.stopReason }, { stopping: false, cancelling: false, stopReason: null });
  assert.equal(run.stopReason, null);
});

test("a job the server reports as stopped counts as cancelled without a Cancel press", () => {
  const slot = view(async () => { throw new Error("No cancel expected."); });
  const run = slot.begin();
  run.observe(status("job", { state: "stopping", stopReason: "time_limit" }));
  assert.equal(run.cancelled, true);
  assert.equal(run.stopReason, "time_limit");
  assert.equal(slot.job()?.stopping, true);
});

test("a view that is no longer showing is not written, and a replaced run no longer receives Cancel", async () => {
  const cancels: string[] = [];
  const slot = view(async (id) => { cancels.push(id); return status(id, { state: "stopping", stopReason: "cancelled" }); });
  const first = slot.begin();
  first.observe(status("first"));
  const second = slot.begin();
  second.observe(status("second"));
  await slot.tracker.cancel();
  assert.deepEqual(cancels, ["second"]);
  first.observe(status("first", { completed: 3 }));
  assert.equal(slot.job()?.completed, 1, "a replaced run cannot overwrite the current progress");
  slot.hide();
  second.observe(status("second", { completed: 4 }));
  assert.equal(slot.job()?.completed, 1);
  second.end();
  assert.notEqual(slot.job(), null, "a hidden view's slot is left alone");
  await slot.tracker.cancel();
  assert.deepEqual(cancels, ["second"], "an ended run has nothing to cancel");
});

test("stopped messages name the change and say what stays done", () => {
  assert.equal(stoppedMessage("cancelled", "The publication", "Created metrics stay published."), "The publication was cancelled. Created metrics stay published.");
  assert.equal(stoppedMessage("time_limit", "The undo", "Deleted metrics stay deleted."), "The undo stopped after 2 hours. Deleted metrics stay deleted.");
});
