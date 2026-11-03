import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import { inspectNodeTarget } from './node-runtime.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const root = path.dirname(path.dirname(scriptPath));

export function copySqliteRuntime(source, destination, target) {
  if (!fs.existsSync(source)) {
    throw new Error(`Missing ${source}. Run npm install before packaging.`);
  }
  if (!target || !['darwin', 'win32', 'linux', 'linuxmusl'].includes(target.platform) || !['arm64', 'x64'].includes(target.arch))
    throw new Error('A supported bundled Node runtime target is required.');
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });
  for (const filename of ['package.json', 'LICENSE']) {
    fs.copyFileSync(path.join(source, filename), path.join(destination, filename));
  }
  fs.cpSync(path.join(source, 'lib'), path.join(destination, 'lib'), {
    recursive: true,
    filter: (filename) => fs.statSync(filename).isDirectory() || filename.endsWith('.js'),
  });

  // Keep the resolver layout, preferring the target prebuild over any local build.
  const addon = [`prebuilds/${target.platform}-${target.arch}.node`,
    'build/Release/better_sqlite3.node', 'build/Debug/better_sqlite3.node']
    .find((filename) => fs.existsSync(path.join(source, filename)));
  if (!addon) throw new Error('Missing better-sqlite3 native addon. Reinstall dependencies before packaging.');
  const targetPath = path.join(destination, addon);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(path.join(source, addon), targetPath);
}

export async function bundleServer(rootDir = root, resourcesDir = path.join(rootDir, 'src-tauri', 'resources'), nodeExecutable = process.execPath) {
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
  copySqliteRuntime(source, destination, inspectNodeTarget(nodeExecutable));
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
