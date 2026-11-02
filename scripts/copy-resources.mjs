import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { bundleServer } from './bundle-server.mjs';
import { assertSupportedNode, validateNodeExecutable, verifyPackagedSqlite } from './node-runtime.mjs';

import { assertMacRuntime } from './macos-compatibility.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const root = path.dirname(path.dirname(scriptPath));

export function runtimeFilename(platform = process.platform) {
  return platform === 'win32' ? 'node.exe' : 'node';
}

export function copyNodeRuntime(resourcesDir, nodeExecutable = process.execPath, platform = process.platform) {
  if (!fs.existsSync(nodeExecutable)) {
    throw new Error(`Node runtime not found at ${nodeExecutable}.`);
  }
  validateNodeExecutable(nodeExecutable);
  const runtimeDir = path.join(resourcesDir, 'runtime');
  const destination = path.join(runtimeDir, runtimeFilename(platform));
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.copyFileSync(nodeExecutable, destination);
  if (platform !== 'win32') fs.chmodSync(destination, 0o755);
  return destination;
}

/** The app runs the installer it shipped with to update itself. */
export function copyInstallers(resourcesDir, rootDir = root) {
  const installerDir = path.join(resourcesDir, 'installer');
  fs.mkdirSync(installerDir, { recursive: true });
  return ['install.sh', 'install.ps1'].map((script) => {
    const destination = path.join(installerDir, script);
    fs.copyFileSync(path.join(rootDir, 'scripts', script), destination);
    return destination;
  });
}

export async function composeResources(rootDir = root) {
  assertSupportedNode();
  assertMacRuntime();
  const resourcesDir = path.join(rootDir, 'src-tauri', 'resources');
  const webSource = path.join(rootDir, 'packages', 'web', 'dist');
  if (!fs.existsSync(webSource)) {
    throw new Error(`Missing ${webSource}. Run npm run build before packaging.`);
  }

  for (const directory of ['server', 'web', 'runtime', 'installer']) {
    fs.rmSync(path.join(resourcesDir, directory), { recursive: true, force: true });
  }

  const webDestination = path.join(resourcesDir, 'web', 'dist');
  fs.mkdirSync(path.dirname(webDestination), { recursive: true });
  fs.cpSync(webSource, webDestination, { recursive: true });
  console.log('copied packages/web/dist -> src-tauri/resources/web/dist');

  copyInstallers(resourcesDir, rootDir);
  console.log('copied scripts/install.sh and scripts/install.ps1 -> src-tauri/resources/installer');

  const runtime = copyNodeRuntime(resourcesDir);
  console.log(`copied Node runtime -> ${path.relative(rootDir, runtime)}`);

  await bundleServer(rootDir);
  verifyPackagedSqlite(runtime, path.join(resourcesDir, 'server', 'dist'));
  console.log('resources composed for Pulse Metric Studio');
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    await composeResources();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
