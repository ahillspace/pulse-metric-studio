import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import { assertSupportedNode } from './node-runtime.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const root = path.dirname(path.dirname(scriptPath));
const children = [];

export const DEV_BUILD_GROUPS = [
  [{ name: 'shared-build', workspace: '@pulse-metric-studio/shared' }],
  [{ name: 'core-build', workspace: '@pulse-metric-studio/core' }],
  [{ name: 'pulse-build', workspace: '@pulse-metric-studio/pulse' }],
];

export const DEV_WATCHERS = [
  { name: 'shared', workspace: '@pulse-metric-studio/shared', script: 'watch' },
  { name: 'core', workspace: '@pulse-metric-studio/core', script: 'watch' },
  { name: 'pulse', workspace: '@pulse-metric-studio/pulse', script: 'watch' },
  { name: 'server', workspace: '@pulse-metric-studio/server', script: 'dev' },
  { name: 'web', workspace: '@pulse-metric-studio/web', script: 'dev' },
];

let shuttingDown = false;

export function resolveNpmInvocation(env = process.env) {
  const npmCli = env.npm_execpath;
  if (!npmCli) {
    throw new Error('npm_execpath is missing. Start development with npm run dev.');
  }
  return { command: process.execPath, argsPrefix: [npmCli] };
}

export function resolveTauriInvocation(rootDir = root) {
  return {
    command: process.execPath,
    argsPrefix: [path.join(rootDir, 'node_modules', '@tauri-apps', 'cli', 'tauri.js')],
  };
}

export function parseDevArgs(args = []) {
  if (args.length === 0) return { mode: 'workspace' };
  if (args.length === 1 && args[0] === '--desktop') return { mode: 'desktop' };
  throw new Error('Usage: node scripts/dev.mjs [--desktop]');
}

function spawnNamed(name, command, args) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, FORCE_COLOR: '1' },
    detached: process.platform !== 'win32',
  });
  child.stdout.on('data', (data) => process.stdout.write(`[${name}] ${data}`));
  child.stderr.on('data', (data) => process.stderr.write(`[${name}] ${data}`));
  children.push(child);
  return child;
}

function spawnNpm(name, args) {
  const invocation = resolveNpmInvocation();
  return spawnNamed(name, invocation.command, [...invocation.argsPrefix, ...args]);
}

function runBuild(name, workspace) {
  return new Promise((resolve, reject) => {
    const child = spawnNpm(name, ['run', 'build', '-w', workspace]);
    child.on('exit', (code) => {
      const index = children.indexOf(child);
      if (index >= 0) children.splice(index, 1);
      if (code === 0) resolve();
      else reject(new Error(`${name} exited with code ${code ?? 1}`));
    });
  });
}

async function buildDependencies(groups = DEV_BUILD_GROUPS) {
  for (const group of groups) {
    await Promise.all(group.map(({ name, workspace }) => runBuild(name, workspace)));
  }
}

function runAndWait(name, command, args) {
  return new Promise((resolve, reject) => {
    const child = spawnNamed(name, command, args);
    child.on('exit', (code) => {
      const index = children.indexOf(child);
      if (index >= 0) children.splice(index, 1);
      if (code === 0) resolve();
      else reject(new Error(`${name} exited with code ${code ?? 1}`));
    });
  });
}

async function runDesktop() {
  await buildDependencies();
  await runAndWait('web-build', resolveNpmInvocation().command, [
    ...resolveNpmInvocation().argsPrefix,
    'run',
    'build',
    '-w',
    '@pulse-metric-studio/web',
  ]);
  await runAndWait('resources', process.execPath, [
    path.join(root, 'scripts', 'copy-resources.mjs'),
  ]);
  const tauri = resolveTauriInvocation();
  await runAndWait('tauri', tauri.command, [
    ...tauri.argsPrefix,
    'dev',
  ]);
}

function runWatcher(name, workspace, script) {
  const child = spawnNpm(name, ['run', script, '-w', workspace]);
  child.on('exit', (code) => {
    if (!shuttingDown) {
      process.stderr.write(`[${name}] exited with code ${code ?? 0}\n`);
      shutdown(code || 1);
    }
  });
}

function shutdown(code = 0) {
  shuttingDown = true;
  for (const child of children) {
    try {
      if (process.platform === 'win32' && child.pid) {
        spawnSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } else if (child.pid) {
        process.kill(-child.pid, 'SIGTERM');
      }
    } catch {
      // The child already exited.
    }
  }
  process.exit(code);
}

export async function main() {
  assertSupportedNode();
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  try {
    const command = parseDevArgs(process.argv.slice(2));
    if (command.mode === 'desktop') {
      await runDesktop();
      return;
    }
    await buildDependencies();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    shutdown(1);
    return;
  }
  for (const watcher of DEV_WATCHERS) {
    runWatcher(watcher.name, watcher.workspace, watcher.script);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  void main();
}
