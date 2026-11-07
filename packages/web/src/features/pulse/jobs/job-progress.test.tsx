import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JobProgress } from "./JobProgress";
import type { MutationJobProgress } from "./tracker";

function job(overrides: Partial<MutationJobProgress> = {}): MutationJobProgress {
  return {
    kind: "fork", total: 112, completed: 30, throttled: true, retryAt: 155_000, serverTime: 100_000,
    stopping: false, cancelling: false, cancelError: null, stopReason: null, ...overrides,
  };
}

const render = (value: MutationJobProgress | null) => renderToStaticMarkup(<JobProgress job={value} onCancel={() => {}} />);
const text = (value: MutationJobProgress) => render(value).replace(/<[^>]+>/g, "");

test("a batch Tableau never limits shows no progress", () => {
  assert.equal(render(null), "");
  assert.equal(render(job({ throttled: false })), "");
});

test("progress reports the count while Tableau holds the batch", () => {
  const html = text(job());
  assert.match(html, /30 of 112 done\./);
  assert.match(html, /Waiting for Tableau to accept more changes\./);
});

test("progress reports sending once the hold has passed", () => {
  assert.match(text(job({ retryAt: null })), /30 of 112 done\. Sending changes\./);
  assert.match(text(job({ retryAt: 100_000 })), /Sending changes\./);
});

test("progress never states a clock time or a Tableau rate", () => {
  for (const value of [job(), job({ retryAt: null })]) {
    const html = text(value);
    assert.doesNotMatch(html, /\d{1,2}:\d{2}/);
    assert.doesNotMatch(html, /per minute|\bAM\b|\bPM\b|until/i);
  }
});

test("stopping replaces the waiting and sending status", () => {
  const html = text(job({ stopping: true }));
  assert.match(html, /Stopping: changes Tableau is already processing will finish, and the rest will not be sent\./);
  assert.doesNotMatch(html, /Waiting for Tableau|Sending changes/);
});
