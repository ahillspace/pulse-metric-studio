import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const scriptPath = fileURLToPath(import.meta.url);
const root = path.dirname(path.dirname(scriptPath));

export function copySqliteRuntime(source, destination) {
  if (!fs.existsSync(source)) {
    throw new Error(`Missing ${source}. Run npm install before packaging.`);
  }
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });
  for (const filename of ['package.json', 'LICENSE']) {
    fs.copyFileSync(path.join(source, filename), path.join(destination, filename));
  }
  fs.cpSync(path.join(source, 'lib'), path.join(destination, 'lib'), {
    recursive: true,
    filter: (filename) => fs.statSync(filename).isDirectory() || filename.endsWith('.js'),
  });

  // Keep the native resolver's layouts without copying node-gyp build metadata.
  const addons = ['build/Debug/better_sqlite3.node', 'build/Release/better_sqlite3.node'];
  for (const platform of ['darwin', 'win32', 'linux', 'linuxmusl']) {
    for (const architecture of ['arm64', 'x64']) {
      addons.push(`prebuilds/${platform}-${architecture}.node`);
    }
  }
  let copiedAddons = 0;
  for (const filename of addons) {
    const original = path.join(source, filename);
    if (!fs.existsSync(original)) continue;
    const target = path.join(destination, filename);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(original, target);
    copiedAddons++;
  }
  if (copiedAddons === 0) throw new Error('Missing better-sqlite3 native addon. Reinstall dependencies before packaging.');
}

export async function bundleServer(rootDir = root, resourcesDir = path.join(rootDir, 'src-tauri', 'resources')) {
  const serverDist = path.join(resourcesDir, 'server', 'dist');
  fs.mkdirSync(serverDist, { recursive: true });
  await esbuild.build({
    absWorkingDir: path.resolve(rootDir),
    entryPoints: [path.join(rootDir, 'packages', 'server', 'src', 'index.ts')],
    bundle: true,
    // Native stages link dependencies from the checkout. Keep bundle module paths stage-relative.
    preserveSymlinks: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: path.join(serverDist, 'index.mjs'),
    external: ['better-sqlite3'],
    sourcemap: false,
    logLevel: 'info',
    banner: {
      js: `import { createRequire as __cR } from 'node:module'; const require = __cR(import.meta.url);`,
    },
  });

  const source = path.join(rootDir, 'node_modules', 'better-sqlite3');
  const destination = path.join(serverDist, 'node_modules', 'better-sqlite3');
  copySqliteRuntime(source, destination);
  console.log('bundled Pulse Metric Studio server -> resources/server/dist/index.mjs');
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    await bundleServer();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
