import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { TableauError } from "@pulse-metric-studio/core";
import { deleteGroup } from "./groups.js";
const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});
const session = {
  serverUrl: "https://tableau.test",
  siteId: "site",
  siteContentUrl: "site",
  userId: "user",
  token: "test",
  apiVersion: "3.27",
};
test("publication group deletion sends only the exact site/group REST DELETE", async () => {
  globalThis.fetch = async (input, init) => {
    assert.equal(
      String(input),
      "https://tableau.test/api/3.27/sites/site/groups/group%2Fid",
    );
    assert.equal(init?.method, "DELETE");
    assert.equal(init?.body, undefined);
    return new Response(null, { status: 204 });
  };
  await deleteGroup(session, "group/id");
});
test("missing group confirms deletion while forbidden deletion remains an error", async () => {
  globalThis.fetch = async () => new Response(null, { status: 404 });
  await deleteGroup(session, "group");
  globalThis.fetch = async () => new Response(null, { status: 403 });
  await assert.rejects(
    () => deleteGroup(session, "group"),
    (error: unknown) => error instanceof TableauError && error.status === 403,
  );
});
