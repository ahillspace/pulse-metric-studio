import assert from "node:assert/strict";
import test from "node:test";
import { replaceNativeCredential, settleCredentialReplacement } from "./credential-replacement";
import { CredentialMutationError, type CredentialMutationResponse } from "../../../tableau-connections-api";

test("adopts the committed owner before a failed old-credential retirement", async () => {
  const calls: string[] = [];
  const result = await settleCredentialReplacement("ticket", {
    adopt: async () => { calls.push("adopt"); },
    retire: async (reference) => { calls.push(`retire:${reference}`); throw new Error("vault unavailable"); },
  });
  assert.deepEqual(calls, ["adopt", "retire:ticket"]);
  assert.equal(result, "cleanup_failed");
});

test("does not request retirement without an issued ticket", async () => {
  const calls: string[] = [];
  const result = await settleCredentialReplacement(undefined, {
    adopt: async () => { calls.push("adopt"); },
    retire: async () => { calls.push("retire"); return "removed"; },
  });
  assert.deepEqual(calls, ["adopt"]);
  assert.equal(result, "none");
});

test("returns guarded retirement outcomes after adoption", async () => {
  for (const outcome of ["removed", "in_use", "cleanup_failed"] as const) {
    let adopted = false;
    const result = await settleCredentialReplacement("ticket", {
      adopt: async () => { adopted = true; },
      retire: async (reference) => {
        assert.equal(adopted, true);
        assert.equal(reference, "ticket");
        return outcome;
      },
    });
    assert.equal(result, outcome);
  }
});

test("retains the old credential if adopting the committed response fails", async () => {
  let retired = false;
  await assert.rejects(() => settleCredentialReplacement("ticket", {
    adopt: async () => { throw new Error("adoption failed"); },
    retire: async () => { retired = true; return "removed"; },
  }), /adoption failed/);
  assert.equal(retired, false);
});

test("committed replacement adopts the new session before guarded cleanup fails", async () => {
  const calls: string[] = [];
  const response = { ok: true, connection: { id: "saved" }, session: { userId: "new-owner" }, retirement: { ticket: "ticket" } } as CredentialMutationResponse;
  let adopted: CredentialMutationResponse | null = null;
  const result = await replaceNativeCredential({
    store: async () => { calls.push("store"); return "new-reference"; },
    replace: async (reference) => { calls.push(`replace:${reference}`); return response; },
    discard: async (reference) => { calls.push(`discard:${reference}`); },
    clearSecret: () => { calls.push("clear"); },
    remember: (ticket) => { calls.push(`remember:${ticket}`); },
    adopt: async (value) => { adopted = value; calls.push("adopt"); },
    retire: async (ticket) => { calls.push(`retire:${ticket}`); throw new Error("vault failure"); },
  });
  assert.equal(adopted, response);
  assert.deepEqual(calls, ["store", "replace:new-reference", "remember:ticket", "adopt", "retire:ticket"]);
  assert.deepEqual(result, { ticket: "ticket", retirement: "cleanup_failed" });
});

test("only a confirmed rejected mutation compensates the staged new credential", async () => {
  for (const confirmed of [true, false]) {
    const discarded: string[] = [];
    let cleared = false;
    await assert.rejects(() => replaceNativeCredential({
      store: async () => "new-reference",
      replace: async () => { throw new CredentialMutationError("failed", confirmed); },
      discard: async (value) => { discarded.push(value); },
      clearSecret: () => { cleared = true; },
      remember: () => { throw new Error("not committed"); },
      adopt: async () => { throw new Error("not committed"); },
      retire: async () => { throw new Error("not committed"); },
    }), /failed/);
    assert.deepEqual(discarded, confirmed ? ["new-reference"] : []);
    assert.equal(cleared, !confirmed);
  }
});
