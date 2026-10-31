import assert from "node:assert/strict";
import test from "node:test";
import { existingFollowTargets, mergeFollowTargetChoices } from "./follow-target-actions.js";
import { unavailableFollowState } from "./follow-state.js";

function fixture() {
  const state = unavailableFollowState(["a", "b", "other"], "No identities");
  for (const id of ["a", "b", "other"]) {
    state.availabilityByMetricId![id] = {
      status: "available", relationshipStatus: "available", followerIdsStatus: "available",
      followerCountStatus: "available", diagnostics: [],
    };
  }
  state.userFollowerIdsByMetricId = { a: ["same", "user"], b: ["same"], other: ["excluded"] };
  state.groupFollowerIdsByMetricId = { a: ["same"], b: ["group"], other: [] };
  return state;
}

test("existing targets union exact selected IDs and retain separate USER/GROUP identities", () => {
  const result = existingFollowTargets(["b", "a", "a"], fixture());
  assert.deepEqual(result.targets.map(({ kind, id }) => [kind, id]), [
    ["USER", "same"], ["GROUP", "group"], ["USER", "user"], ["GROUP", "same"],
  ]);
  assert.deepEqual(result.incompleteMetricIds, []);
});

test("existing pills survive repeated additions and directory names resolve by type and ID", () => {
  const additions = existingFollowTargets(["a"], fixture()).targets;
  const directory = [{ id: "same", kind: "USER" as const, label: "Alice" }];
  const selected = [{ id: "manual", kind: "USER" as const, label: "Manual choice" }];
  const merged = mergeFollowTargetChoices(selected, additions, directory);
  assert.deepEqual(mergeFollowTargetChoices(merged, additions, directory), merged);
  assert.deepEqual(merged.map((target) => target.label), ["Manual choice", "Alice", "user", "same"]);
  assert.equal(merged[3].kind, "GROUP");
});

test("partial inventory retains known identities and reports missing metrics without trusting counts", () => {
  const state = fixture();
  state.availabilityByMetricId!.a.followerIdsStatus = "partial";
  state.availabilityByMetricId!.a.diagnostics = [{ message: "Unsupported follower type" }];
  state.followerCountsByMetricId.missing = 0;
  const result = existingFollowTargets(["a", "missing"], state);
  assert.equal(result.targets.length, 3);
  assert.deepEqual(result.incompleteMetricIds, ["a", "missing"]);
  assert.deepEqual(result.diagnostics, ["Unsupported follower type"]);
});

test("unavailable inventories exclude stale arrays and never report confirmed empty", () => {
  const state = fixture();
  state.availabilityByMetricId!.a.followerIdsStatus = "unavailable";
  assert.deepEqual(existingFollowTargets(["a"], state).targets, []);
  assert.deepEqual(existingFollowTargets(["a"], state).incompleteMetricIds, ["a"]);
  assert.deepEqual(existingFollowTargets(["a"], null).incompleteMetricIds, ["a"]);
  delete state.groupFollowerIdsByMetricId!.b;
  assert.deepEqual(existingFollowTargets(["b"], state).incompleteMetricIds, ["b"]);
});

test("identity completeness is independent of group context and count availability", () => {
  const state = fixture();
  state.groupContextUnavailable = true;
  state.availabilityByMetricId!.a.status = "partial";
  state.availabilityByMetricId!.a.relationshipStatus = "unavailable";
  state.availabilityByMetricId!.a.followerCountStatus = "unavailable";
  assert.deepEqual(existingFollowTargets(["a"], state).incompleteMetricIds, []);
  state.userFollowerIdsByMetricId!.a = [];
  state.groupFollowerIdsByMetricId!.a = [];
  assert.deepEqual(existingFollowTargets(["a"], state).targets, []);
  assert.deepEqual(existingFollowTargets(["a"], state).incompleteMetricIds, []);
});
