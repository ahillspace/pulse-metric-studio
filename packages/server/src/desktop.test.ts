import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { acquireDesktopOwnership } from "./desktop.js";

test("one sidecar owns a canonical data directory until its OS listener closes", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pulse-executor-"));
  const first = await acquireDesktopOwnership(directory);
  try {
    await assert.rejects(
      acquireDesktopOwnership(path.join(directory, ".")),
      /exclusive ownership/,
    );
    await new Promise<void>((resolve, reject) =>
      first.close((error) => (error ? reject(error) : resolve())),
    );
    const replacement = await acquireDesktopOwnership(directory);
    await new Promise<void>((resolve, reject) =>
      replacement.close((error) => (error ? reject(error) : resolve())),
    );
  } finally {
    if (first.listening) first.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
