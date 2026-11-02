import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

function workspaces(root, stage) {
  const manifestRoot = fs.existsSync(path.join(stage, 'package.json')) ? stage : root;
  const manifest = JSON.parse(fs.readFileSync(path.join(manifestRoot, 'package.json'), 'utf8'));
  if (!Array.isArray(manifest.workspaces)) throw new Error('Native staging requires an explicit workspace directory list.');
  const names = new Set();
  return manifest.workspaces.map((workspace) => {
    if (typeof workspace !== 'string' || /[*?{}]/.test(workspace)) throw new Error('Native staging requires explicit workspace directories, without patterns.');
    const source = path.resolve(root, workspace);
    if (!within(path.resolve(root), source) || source === path.resolve(root)) throw new Error('Native staging workspace must be inside the repository.');
    const destination = path.resolve(stage, path.relative(root, source));
    const filename = path.join(fs.existsSync(path.join(destination, 'package.json')) ? destination : source, 'package.json');
    const { name } = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (typeof name !== 'string' || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) || names.has(name)) throw new Error('Native staging requires unique valid workspace package names.');
    names.add(name);
    return { name, source, destination };
  });
}

function ownedDirectory(directory) {
  if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) throw new Error('Native staging cannot write through an existing dependency directory link.');
  fs.mkdirSync(directory, { recursive: true });
}

// Materialize resolution directories, including third-party nested node_modules.
// File hard links share installed, immutable third-party bytes, not their lookup paths.
export function linkNativeStageDependencies(root, stage) {
  root = path.resolve(root);
  stage = path.resolve(stage);
  const packages = workspaces(root, stage);
  const commandTargets = new Set();
  const byName = new Map(packages.map((entry) => [entry.name, entry]));
  const roots = [{ source: path.join(root, 'node_modules'), destination: path.join(stage, 'node_modules') },
    ...packages.map((entry) => ({ source: path.join(entry.source, 'node_modules'), destination: path.join(entry.destination, 'node_modules') }))];
  const translate = (filename) => {
    // Match nested dependency roots before their containing workspace.
    for (const entry of [...roots, ...packages].sort((left, right) => right.source.length - left.source.length)) {
      if (within(entry.source, filename)) return path.join(entry.destination, path.relative(entry.source, filename));
    }
    return null;
  };
  const directoryLink = (target, destination) => {
    ownedDirectory(path.dirname(destination));
    fs.symlinkSync(target, destination, process.platform === 'win32' ? 'junction' : 'dir');
  };
  const materialize = (source, destination, ancestors, owned = false) => {
    const info = fs.lstatSync(source);
    if (info.isSymbolicLink()) {
      const logicalTarget = path.resolve(path.dirname(source), fs.readlinkSync(source));
      const target = translate(logicalTarget);
      if (target) {
        ownedDirectory(path.dirname(destination));
        if (fs.statSync(source).isDirectory()) directoryLink(target, destination);
        else {
          fs.symlinkSync(path.relative(path.dirname(destination), target), destination, 'file');
          if (owned) commandTargets.add(target);
        }
        return;
      }
      source = fs.realpathSync(source);
    }
    const stat = fs.statSync(source);
    if (stat.isDirectory()) {
      const real = fs.realpathSync(source);
      if (ancestors.has(real)) throw new Error('Native staging found a cyclic dependency directory.');
      const next = new Set([...ancestors, real]);
      ownedDirectory(destination);
      for (const entry of fs.readdirSync(source)) {
        if (['.cache', '.vite', '.vite-temp'].includes(entry)) continue;
        if (entry === 'node_modules') modules(path.join(source, entry), path.join(destination, entry), next);
        else materialize(path.join(source, entry), path.join(destination, entry), next, owned || entry.startsWith('.'));
      }
    } else if (stat.isFile()) {
      ownedDirectory(path.dirname(destination));
      if (!owned) {
        try { fs.linkSync(source, destination); return; }
        catch (error) { if (error.code === 'EEXIST') throw error; }
      }
      fs.copyFileSync(source, destination);
    } else throw new Error('Native staging requires regular dependency files or links.');
  };
  const modules = (source, destination, ancestors = new Set()) => {
    ownedDirectory(destination);
    for (const entry of fs.readdirSync(source)) {
      if (['.cache', '.vite', '.vite-temp'].includes(entry)) continue;
      if (entry.startsWith('@') && fs.statSync(path.join(source, entry)).isDirectory()) {
        ownedDirectory(path.join(destination, entry));
        for (const name of fs.readdirSync(path.join(source, entry))) {
          const workspace = byName.get(`${entry}/${name}`);
          const target = path.join(destination, entry, name);
          if (workspace) directoryLink(workspace.destination, target);
          else materialize(path.join(source, entry, name), target, ancestors);
        }
      } else {
        const workspace = byName.get(entry);
        if (workspace) directoryLink(workspace.destination, path.join(destination, entry));
        else materialize(path.join(source, entry), path.join(destination, entry), ancestors, entry.startsWith('.'));
      }
    }
    for (const workspace of packages) {
      const destinationLink = path.join(destination, workspace.name);
      if (!fs.existsSync(destinationLink)) directoryLink(workspace.destination, destinationLink);
    }
  };
  for (const entry of roots) {
    if (fs.existsSync(entry.source)) modules(entry.source, entry.destination);
    else if (entry.source === roots[0].source) throw new Error('Install root dependencies before native packaging.');
  }
  // Unix .bin entries are links into package files. Break their shared inode
  // too, so rewriting a staged command never edits an installed source tool.
  for (const target of commandTargets) {
    if (!fs.existsSync(target)) continue;
    const copy = `${target}.pulse-stage-${randomUUID()}`;
    try {
      fs.copyFileSync(target, copy, fs.constants.COPYFILE_EXCL);
      fs.renameSync(copy, target);
    } finally { if (fs.existsSync(copy)) fs.rmSync(copy); }
  }
}

function npmCli() {
  const executableDirectory = path.dirname(process.execPath);
  const candidates = [process.env.npm_execpath,
    path.join(executableDirectory, 'node_modules/npm/bin/npm-cli.js'),
    path.join(executableDirectory, '../lib/node_modules/npm/bin/npm-cli.js')];
  try { candidates.push(path.join(path.dirname(createRequire(import.meta.url).resolve('npm/package.json')), 'bin/npm-cli.js')); } catch {}
  const cli = candidates.find((filename) => filename && fs.existsSync(filename));
  if (!cli) throw new Error('The npm CLI is unavailable. Start native packaging with npm run tauri:build.');
  return cli;
}

export function buildNativeStageWorkspaces(stage) {
  const packages = workspaces(stage, stage);
  if (!packages.length) return;
  for (const workspace of packages) {
    const output = path.join(workspace.destination, 'dist');
    if (!within(path.resolve(stage), output) || fs.existsSync(output) && fs.lstatSync(output).isSymbolicLink()) throw new Error('Staged workspace outputs must remain inside the native stage.');
    fs.rmSync(output, { recursive: true, force: true });
  }
  const environment = { ...process.env };
  const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  environment[pathKey] = `${path.dirname(process.execPath)}${path.delimiter}${environment[pathKey] ?? ''}`;
  delete environment.NODE_PATH;
  const result = spawnSync(process.execPath, [npmCli(), 'run', 'build', '--workspaces', '--if-present'], {
    cwd: stage, env: environment, stdio: 'inherit', windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error('The staged Pulse workspaces did not build.');
}
