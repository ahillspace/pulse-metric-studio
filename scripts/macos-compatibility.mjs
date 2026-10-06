import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Node 22 official x64/arm64 binaries target macOS 11. Later majors raise that floor.
export const MACOS_COMPATIBILITY_VERSION = "11.0";
export function assertMacRuntime(
  version = process.versions.node,
  platform = process.platform,
) {
  if (
    platform === "darwin" &&
    Number(version.replace(/^v/, "").split(".")[0]) !== 22
  )
    throw new Error(
      "Pulse macOS compatibility requires the pinned Node 22 runtime. Use the version in .nvmrc before packaging.",
    );
}
export function deploymentVersions(output) {
  return [
    ...output.matchAll(
      /\bcmd (LC_BUILD_VERSION|LC_VERSION_MIN_MACOSX)\b([\s\S]*?)(?=Load command|$)/g,
    ),
  ]
    .map(
      (match) => /\b(?:minos|version) (\d+(?:\.\d+){0,2})/.exec(match[2])?.[1],
    )
    .filter(Boolean);
}
export function assertDeploymentVersion(version, filename) {
  const [major, minor = 0] = version.split(".").map(Number);
  if (major > 11 || (major === 11 && minor > 0))
    throw new Error(
      `${filename} requires macOS ${version}, above the declared ${MACOS_COMPATIBILITY_VERSION} compatibility target.`,
    );
}
export function verifyMacArtifacts(directory) {
  let inspected = 0;
  const visit = (folder) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const filename = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        visit(filename);
        continue;
      }
      if (!entry.isFile()) continue;
      const bytes = Buffer.alloc(4);
      const handle = fs.openSync(filename, "r");
      let length;
      try {
        length = fs.readSync(handle, bytes, 0, 4, 0);
      } finally {
        fs.closeSync(handle);
      }
      if (
        length !== 4 ||
        ![
          "feedface",
          "feedfacf",
          "cefaedfe",
          "cffaedfe",
          "cafebabe",
          "bebafeca",
          "cafebabf",
          "bfbafeca",
        ].includes(bytes.toString("hex"))
      )
        continue;
      const result = spawnSync("otool", ["-l", filename], {
        encoding: "utf8",
        timeout: 15000,
      });
      if (result.error || result.status !== 0)
        throw new Error(
          `Cannot inspect macOS binary compatibility: ${filename}`,
        );
      const versions = deploymentVersions(result.stdout);
      if (!versions.length)
        throw new Error(`No macOS deployment version found in ${filename}`);
      versions.forEach((version) => assertDeploymentVersion(version, filename));
      inspected++;
    }
  };
  visit(directory);
  if (!inspected)
    throw new Error("No Mach-O binaries found in the packaged macOS app.");
  return {
    minimumSystemVersion: MACOS_COMPATIBILITY_VERSION,
    binariesInspected: inspected,
    runtimeQualified: false,
  };
}
