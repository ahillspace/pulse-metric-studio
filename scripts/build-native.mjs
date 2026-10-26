import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { linkNativeStageDependencies } from "./native-stage-dependencies.mjs";
import {
  assertMacRuntime,
  MACOS_COMPATIBILITY_VERSION,
  verifyMacArtifacts,
} from "./macos-compatibility.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function physicalPath(filename) {
  if (fs.existsSync(filename)) return fs.realpathSync(filename);
  const parent = path.dirname(filename);
  if (parent === filename) throw new Error("Native artifact output has no existing filesystem root.");
  return path.join(physicalPath(parent), path.basename(filename));
}

function assertOutputDirectory(output, target, validation) {
  if (fs.existsSync(output) && fs.lstatSync(output).isSymbolicLink())
    throw new Error("Native artifact output cannot be a directory link.");
  const actual = physicalPath(output);
  const repository = fs.realpathSync(root);
  const protectedDirectories = [".git", ".github", "scripts", "packages", "src-tauri", "node_modules", "docs", "design"];
  if (within(actual, repository) || within(target, actual) || within(actual, target)
    || protectedDirectories.some(name => within(path.join(repository, name), actual)))
    throw new Error("Native artifact output must not replace repository source or the build target.");
  if (!fs.existsSync(output)) return;
  if (!fs.statSync(output).isDirectory()) throw new Error("Native artifact output must be a directory.");
  if (!fs.readdirSync(output).length) return;
  let evidence;
  try { evidence = JSON.parse(fs.readFileSync(path.join(output, "build-evidence.json"), "utf8")); } catch {}
  const expectedIdentifier = validation
    ? /^com\.ahillspace\.pulsemetricstudio\.validation\.[a-f0-9]+$/
    : /^com\.ahillspace\.pulsemetricstudio$/;
  if (!evidence || evidence.validation !== validation || !expectedIdentifier.test(evidence.identifier ?? ""))
    throw new Error("Native artifact output is nonempty and is not owned by this build mode.");
}

function removeOutputSibling(directory, parent, prefix) {
  if (path.dirname(directory) !== parent || !path.basename(directory).startsWith(prefix))
    throw new Error("Refusing to remove an unowned native artifact directory.");
  fs.rmSync(directory, { recursive: true, force: true });
}

function publishOutput(collected, output) {
  const parent = path.dirname(output);
  const previous = path.join(parent, `.pulse-native-previous-${crypto.randomUUID()}`);
  const hadPrevious = fs.existsSync(output);
  if (hadPrevious) fs.renameSync(output, previous);
  try {
    fs.renameSync(collected, output);
  } catch (error) {
    if (hadPrevious) {
      try { fs.renameSync(previous, output); }
      catch (restoreError) { throw new AggregateError([error, restoreError], `Cannot publish native artifacts; previous output retained at ${previous}`); }
    }
    throw error;
  }
  if (hadPrevious) {
    try { removeOutputSibling(previous, parent, ".pulse-native-previous-"); }
    catch (error) { console.warn(`Previous native artifacts retained at ${previous}: ${error.message}`); }
  }
}

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

const temporary = fs.realpathSync(os.tmpdir());
const target = path.join(
  temporary,
  validation
    ? "pulse-metric-studio-native-validation-target"
    : "pulse-metric-studio-native-target",
);
assertOutputDirectory(output, target, validation);
if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink())
  throw new Error("The native build target cannot be a directory link.");
fs.mkdirSync(target, { recursive: true });
const lockPath = path.join(target, ".pulse-native-build.lock");
let lock;
try { lock = fs.openSync(lockPath, "wx"); }
catch (error) {
  if (error.code !== "EEXIST") throw error;
  throw new Error(`Another native build owns ${lockPath}. If a previous build was interrupted, verify its process has exited before removing that lock.`);
}
let collected;
try {
  fs.writeFileSync(lock, String(process.pid));
  // Bundle outputs are invocation-owned; compiled dependencies remain cached.
  const bundles = path.join(target, "release/bundle");
  if (physicalPath(bundles) !== bundles)
    throw new Error("The native bundle directory must remain inside its owned build target without directory links.");
  fs.rmSync(bundles, { recursive: true, force: true });

  // Stage source and resources away from desktop processes using the developer checkout.
  const stage = fs.mkdtempSync(
    path.join(temporary, "pulse-metric-studio-native-stage-"),
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
  linkNativeStageDependencies(root, stage);
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
    const macosCompatibility =
      process.platform === "darwin"
        ? verifyMacArtifacts(path.join(bundles, "macos"))
        : undefined;
    if (macosCompatibility)
      console.log("macOS compatibility evidence:", macosCompatibility);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    collected = fs.mkdtempSync(path.join(path.dirname(output), ".pulse-native-output-"));
    if (!validation || process.platform !== "win32")
      fs.cpSync(bundles, collected, { recursive: true });
    let executable;
    if (validation && process.platform === "win32") {
      executable = path.join(output, "pulse-metric-studio.exe");
      fs.copyFileSync(path.join(target, "release/pulse-metric-studio.exe"), path.join(collected, "pulse-metric-studio.exe"));
      fs.cpSync(
        path.join(stage, "src-tauri/resources"),
        path.join(collected, "resources"),
        { recursive: true },
      );
    }
    const sha256 = (filename) =>
      crypto.createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
    fs.copyFileSync(configFile, path.join(collected, "tauri.conf.json"));
    const installerArtifacts = [];
    const inspectArtifacts = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const filename = path.join(directory, entry.name);
        if (entry.isDirectory()) inspectArtifacts(filename);
        else if (/\.(msi|exe|dmg|pkg)$/i.test(entry.name))
          installerArtifacts.push({
            path: path.relative(collected, filename),
            size: fs.statSync(filename).size,
            sha256: sha256(filename),
          });
      }
    };
    if (!validation) inspectArtifacts(collected);
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
      path.join(collected, "build-evidence.json"),
      JSON.stringify(record, null, 2),
    );
    assertOutputDirectory(output, target, validation);
    publishOutput(collected, output);
    console.log(`Native Pulse Metric Studio artifacts: ${output}`);
  }
} finally {
  try {
    if (collected && fs.existsSync(collected))
      removeOutputSibling(collected, path.dirname(output), ".pulse-native-output-");
  } finally {
    fs.closeSync(lock);
    fs.unlinkSync(lockPath);
  }
}
