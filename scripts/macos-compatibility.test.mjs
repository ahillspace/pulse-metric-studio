import assert from "node:assert/strict";
import test from "node:test";
import {
  assertMacRuntime,
  assertDeploymentVersion,
  deploymentVersions,
} from "./macos-compatibility.mjs";
test("macOS runtime selection cannot silently raise the supported baseline", () => {
  assert.doesNotThrow(() => assertMacRuntime("22.23.2", "darwin"));
  assert.throws(() => assertMacRuntime("25.6.1", "darwin"), /pinned Node 22/);
  assert.doesNotThrow(() => assertMacRuntime("25.6.1", "win32"));
});
test("Mach-O deployment versions inspect every architecture and reject a raised floor", () => {
  const versions = deploymentVersions(
    "Load command 1\n cmd LC_BUILD_VERSION\n cmdsize 32\n platform 1\n minos 11.0\n sdk 15.0\nLoad command 2\n cmd LC_VERSION_MIN_MACOSX\n cmdsize 16\n version 13.5\n sdk 15.0\n",
  );
  assert.deepEqual(versions, ["11.0", "13.5"]);
  assert.doesNotThrow(() => assertDeploymentVersion(versions[0], "node"));
  assert.throws(
    () => assertDeploymentVersion(versions[1], "native.node"),
    /above the declared/,
  );
});
