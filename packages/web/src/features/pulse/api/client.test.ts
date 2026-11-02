import assert from "node:assert/strict";
import test from "node:test";
import { pulseRequest, PulseApiError } from "./client";
import { pulseDimensionalForkApi } from "../dimensional-fork-api";

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

test("dimension discovery sends complete large selections in POST bodies", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const sourceMetricIds = Array.from({ length: 1000 }, (_, index) =>
    `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  );
  const requests: Array<{ path: string; body: unknown }> = [];
  const fieldId = "Country/Region";
  globalThis.fetch = async (input, init) => {
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init.headers).get("Content-Type"), "application/json");
    const path = String(input);
    requests.push({ path, body: JSON.parse(String(init.body)) });
    return Response.json(path.endsWith("/count") ? { fieldId, count: 2 }
      : path.endsWith("/values") ? { fieldId, values: [], truncated: false }
        : { fields: [] });
  };
  await pulseDimensionalForkApi.fields(sourceMetricIds);
  await pulseDimensionalForkApi.count(sourceMetricIds, fieldId);
  await pulseDimensionalForkApi.values(sourceMetricIds, fieldId, "West", { all: true });
  assert.deepEqual(requests, [
    { path: "/api/pulse/dimensions", body: { sourceMetricIds } },
    { path: "/api/pulse/dimensions/count", body: { sourceMetricIds, fieldId } },
    { path: "/api/pulse/dimensions/values", body: { sourceMetricIds, fieldId, search: "West", all: true } },
  ]);
});
