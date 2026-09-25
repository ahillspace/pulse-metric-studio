import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const scriptPath = fileURLToPath(import.meta.url);
const root = path.dirname(path.dirname(scriptPath));

export async function bundleServer(rootDir = root, resourcesDir = path.join(rootDir, 'src-tauri', 'resources')) {
  const serverDist = path.join(resourcesDir, 'server', 'dist');
  fs.mkdirSync(serverDist, { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(rootDir, 'packages', 'server', 'src', 'index.ts')],
    bundle: true,
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
  if (!fs.existsSync(source)) {
    throw new Error(`Missing ${source}. Run npm install before packaging.`);
  }
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true });

  // Preserve prebuilt native addons, excluding build-time sources only.
  for (const junk of ['.github', 'deps', 'src', 'binding.gyp']) {
    fs.rmSync(path.join(destination, junk), { recursive: true, force: true });
  }
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
