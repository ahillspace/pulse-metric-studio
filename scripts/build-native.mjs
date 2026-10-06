import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  assertMacRuntime,
  MACOS_COMPATIBILITY_VERSION,
  verifyMacArtifacts,
} from "./macos-compatibility.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const validation = process.argv.includes("--validation");
const outputIndex = process.argv.indexOf("--output");
const output = path.resolve(
  root,
  outputIndex < 0
    ? validation
      ? ".codex/native-validation"
      : "native-artifacts"
    : process.argv[outputIndex + 1],
);
if (!["win32", "darwin"].includes(process.platform))
  throw new Error("Native Pulse Metric Studio installers require Windows or macOS.");
assertMacRuntime();
if (!fs.existsSync(path.join(root, "packages/web/dist/index.html")))
  throw new Error("Build the Pulse frontend before native packaging.");

// Stage source and resources away from desktop processes using the developer checkout.
const stage = fs.mkdtempSync(
  path.join(os.tmpdir(), "pulse-metric-studio-native-stage-"),
);
const target = path.join(
  os.tmpdir(),
  validation
    ? "pulse-metric-studio-native-validation-target"
    : "pulse-metric-studio-native-target",
);
console.log(`Native build staging: ${stage}`);
for (const name of [
  "package.json",
  "package-lock.json",
  "tsconfig.base.json",
  "scripts",
  "packages",
  "src-tauri",
]) {
  fs.cpSync(path.join(root, name), path.join(stage, name), {
    recursive: true,
    filter: (source) =>
      ![
        "node_modules",
        "target",
        "resources",
        "test-results",
        "playwright-report",
        "gen",
      ].includes(path.basename(source)),
  });
}
fs.symlinkSync(
  path.join(root, "node_modules"),
  path.join(stage, "node_modules"),
  process.platform === "win32" ? "junction" : "dir",
);
const configFile = path.join(stage, "src-tauri/tauri.conf.json");
const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
if (validation) {
  config.identifier = `com.ahillspace.pulsemetricstudio.validation.${crypto.randomUUID().replaceAll("-", "")}`;
  config.productName = "Pulse Metric Studio validation";
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  console.log(`Isolated validation identity: ${config.identifier}`);
}
const frontend = spawnSync(
  process.execPath,
  [
    path.join(root, "node_modules/vite/bin/vite.js"),
    "build",
  ],
  {
    cwd: path.join(stage, "packages/web"),
    stdio: "inherit",
    windowsHide: true,
  },
);
if (frontend.error || frontend.status !== 0)
  throw new Error("The staged Pulse frontend did not build.");
const environment = { ...process.env, CARGO_TARGET_DIR: target };
if (process.platform === "darwin")
  environment.MACOSX_DEPLOYMENT_TARGET = MACOS_COMPATIBILITY_VERSION;
delete environment.TAURI_CONFIG;
const result = spawnSync(
  process.execPath,
  [
    path.join(root, "node_modules/@tauri-apps/cli/tauri.js"),
    "build",
    "--config",
    "src-tauri/tauri.conf.json",
    ...(validation && process.platform === "win32" ? ["--no-bundle"] : []),
  ],
  {
    cwd: stage,
    env: environment,
    stdio: "inherit",
    windowsHide: true,
  },
);
if (result.error || result.status !== 0) {
  console.error(`Native build failed; staging retained at ${stage}`);
  process.exitCode = result.status || 1;
} else {
  const bundles = path.join(target, "release/bundle");
  const macosCompatibility =
    process.platform === "darwin"
      ? verifyMacArtifacts(path.join(bundles, "macos"))
      : undefined;
  if (macosCompatibility)
    console.log("macOS compatibility evidence:", macosCompatibility);
  fs.mkdirSync(output, { recursive: true });
  if (!validation || process.platform !== "win32")
    fs.cpSync(bundles, output, { recursive: true });
  let executable;
  if (validation && process.platform === "win32") {
    executable = path.join(output, "pulse-metric-studio.exe");
    fs.copyFileSync(path.join(target, "release/pulse-metric-studio.exe"), executable);
    fs.cpSync(
      path.join(stage, "src-tauri/resources"),
      path.join(output, "resources"),
      { recursive: true },
    );
  }
  const sha256 = (filename) =>
    crypto.createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
  fs.copyFileSync(configFile, path.join(output, "tauri.conf.json"));
  const installerArtifacts = [];
  const inspectArtifacts = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) inspectArtifacts(filename);
      else if (/\.(msi|exe|dmg|pkg)$/i.test(entry.name))
        installerArtifacts.push({
          path: path.relative(output, filename),
          size: fs.statSync(filename).size,
          sha256: sha256(filename),
        });
    }
  };
  if (!validation) inspectArtifacts(output);
  const record = {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    macosCompatibility,
    builtAt: new Date().toISOString(),
    identifier: config.identifier,
    validation,
    stage,
    executable,
    installerArtifacts,
    backendSha256: sha256(
      path.join(stage, "src-tauri/resources/server/dist/index.mjs"),
    ),
    frontendIndexSha256: sha256(
      path.join(stage, "packages/web/dist/index.html"),
    ),
    desktopConfigSha256: sha256(
      path.join(stage, "src-tauri/tauri.conf.json"),
    ),
  };
  fs.writeFileSync(
    path.join(output, "build-evidence.json"),
    JSON.stringify(record, null, 2),
  );
  console.log(`Native Pulse Metric Studio artifacts: ${output}`);
}
