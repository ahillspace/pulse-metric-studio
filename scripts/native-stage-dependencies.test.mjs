import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildSync } from "esbuild";
import { linkNativeStageDependencies } from "./native-stage-dependencies.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
function temporary(testContext) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "pulse-native-dependencies-"),
  );
  testContext.after(() => {
    assert.equal(
      path.dirname(path.resolve(directory)),
      path.resolve(os.tmpdir()),
    );
    assert.ok(
      path.basename(directory).startsWith("pulse-native-dependencies-"),
    );
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}
function write(filename, content) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, content);
}

test("native stage preserves workspace-local resolution ahead of root dependencies", (t) => {
  const directory = temporary(t);
  const source = path.join(directory, "source");
  const stage = path.join(directory, "stage");
  write(
    path.join(source, "package.json"),
    JSON.stringify({ workspaces: ["packages/web", "packages/shared"] }),
  );
  write(
    path.join(source, "node_modules/example/index.js"),
    "module.exports = 'root';",
  );
  write(
    path.join(source, "packages/web/node_modules/example/index.js"),
    "module.exports = 'web';",
  );
  linkNativeStageDependencies(source, stage);
  const fromRoot = createRequire(path.join(stage, "entry.cjs"));
  const fromWeb = createRequire(path.join(stage, "packages/web/entry.cjs"));
  assert.equal(fromRoot("example"), "root");
  assert.equal(fromWeb("example"), "web");
  assert.equal(
    fs.existsSync(path.join(stage, "packages/shared/node_modules")),
    false,
  );
  assert.equal(
    fs.realpathSync(path.join(stage, "packages/web/node_modules")),
    fs.realpathSync(path.join(source, "packages/web/node_modules")),
  );
});

test("staged frontend bundles the installed OpenURL plugin from the web workspace", (t) => {
  const stage = temporary(t);
  linkNativeStageDependencies(root, stage);
  const stagedWeb = path.join(stage, "packages/web");
  fs.mkdirSync(stagedWeb, { recursive: true });
  const requireFromStage = createRequire(path.join(stagedWeb, "entry.cjs"));
  assert.equal(
    requireFromStage.resolve("@tauri-apps/plugin-opener"),
    createRequire(path.join(root, "packages/web/package.json")).resolve(
      "@tauri-apps/plugin-opener",
    ),
  );
  const result = buildSync({
    stdin: {
      contents: 'export { openUrl } from "@tauri-apps/plugin-opener";',
      resolveDir: stagedWeb,
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
  });
  assert.match(result.outputFiles[0].text, /plugin:opener\|open_url/);
});

test("native dependency staging rejects workspaces outside the checkout", (t) => {
  const directory = temporary(t);
  write(
    path.join(directory, "package.json"),
    JSON.stringify({ workspaces: ["../outside"] }),
  );
  fs.mkdirSync(path.join(directory, "node_modules"));
  assert.throws(
    () => linkNativeStageDependencies(directory, path.join(directory, "stage")),
    /inside the repository/,
  );
});
