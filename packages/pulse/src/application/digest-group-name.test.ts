import assert from "node:assert/strict";
import { test } from "node:test";
import { digestGroupName } from "./publish.js";

test("digest group uses the exact product label, full datasource, and chosen audience", () => {
  assert.equal(
    digestGroupName("Superstore Sales Cloud (CalcTEST)", "delete me"),
    "pmStudio - Superstore Sales Cloud (CalcTEST) - delete me",
  );
});

test("group names preserve punctuation, Unicode, and long labels without silent rewriting", () => {
  const datasource = "Sales & Operations (Worldwide) ".repeat(4);
  const audience = "Finance / Europe & Asia";
  assert.equal(digestGroupName(datasource, audience), `pmStudio - ${datasource} - ${audience}`);
  assert.equal(digestGroupName("Ventes", "?quipe"), "pmStudio - Ventes - ?quipe");
});
