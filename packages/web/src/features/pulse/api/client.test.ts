import assert from "node:assert/strict";
import test from "node:test";
import { pulseRequest, PulseApiError } from "./client";

test("structured workflow errors retain status, message, code, and conflict details", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  for (const nested of [false, true]) {
    const body = {
      message: "Draft changed in another window",
      code: "draft_revision_conflict",
      details: { currentRevision: 7 },
    };
    globalThis.fetch = async () =>
      new Response(JSON.stringify(nested ? { error: body } : body), {
        status: 409,
      });
    await assert.rejects(
      pulseRequest("/api/pulse/drafts/example", "PUT", {}),
      (error: unknown) => {
        assert.ok(error instanceof PulseApiError);
        assert.equal(error.message, body.message);
        assert.equal(error.status, 409);
        assert.equal(error.code, body.code);
        assert.deepEqual(error.details, body.details);
        return true;
      },
    );
  }
});
