import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

export function sha256File(filename) {
  const file = fs.openSync(filename, 'r');
  try {
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.alloc(1024 * 1024);
    let size;
    while ((size = fs.readSync(file, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, size));
    return hash.digest('hex');
  } finally { fs.closeSync(file); }
}
const digest = /^[a-f0-9]{64}$/;
const commit = /^[a-f0-9]{40,64}$/;
function git(root, args, input) {
  const result = spawnSync('git', ['-C', root, ...args], { input, encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error('Native source identity requires a readable Git checkout with a committed HEAD.');
  return result.stdout;
}

/** Hash Git-visible working-tree contents, including nonignored untracked files, without publishing paths. */
export function captureSourceIdentity(root) {
  const revision = git(root, ['rev-parse', '--verify', 'HEAD']).trim();
  if (!commit.test(revision)) throw new Error('Invalid source commit identity.');
  const tracked = git(root, ['ls-files', '--stage', '-z']).split('\0').filter(Boolean);
  const entries = new Map();
  for (const entry of tracked) {
    const match = /^(\d+) [a-f0-9]+ (\d)\t([\s\S]+)$/.exec(entry);
    if (!match || match[2] !== '0' || match[1] === '160000') throw new Error('Native source identity does not accept unresolved Git entries or submodules.');
    entries.set(match[3], match[1]);
  }
  for (const filename of git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)) entries.set(filename, '100644');
  if (entries.size > 100000) throw new Error('Native source identity exceeds the local file limit.');
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const records = [];
  const present = [];
  for (const [filename, mode] of [...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const resolved = path.resolve(root, filename);
    const relative = path.relative(root, resolved);
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) throw new Error('Native source identity contains an invalid relative path.');
    let content = 'deleted';
    let effectiveMode = mode;
    if (fs.existsSync(resolved)) {
      const stat = fs.lstatSync(resolved);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Native source identity requires regular source files.');
      if (process.platform !== 'win32') effectiveMode = stat.mode & 0o111 ? '100755' : '100644';
      bytes += stat.size;
      if (bytes > 256 * 1024 * 1024) throw new Error('Native source identity exceeds the local content limit.');
      content = null;
      present.push(filename);
    }
    records.push([filename.replaceAll('\\', '/'), effectiveMode, content]);
  }
  // Git applies its text/binary attributes and checkout normalization in one bounded batch.
  const blobs = present.length ? git(root, ['hash-object', '--stdin-paths'], present.map((filename) => JSON.stringify(filename)).join('\n') + '\n').trim().split('\n') : [];
  if (blobs.length !== present.length || blobs.some((blob) => !/^[a-f0-9]{40,64}$/.test(blob))) throw new Error('Native source content could not be normalized.');
  let index = 0;
  for (const record of records) { if (record[2] === null) record[2] = blobs[index++]; hash.update(JSON.stringify(record) + '\n'); }
  return { commit: revision, dirty: git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).length > 0, contentSha256: hash.digest('hex') };
}

export function sourceIdentityKey(source) {
  if (!source || !commit.test(source.commit ?? '') || typeof source.dirty !== 'boolean' || !digest.test(source.contentSha256 ?? '')) throw new Error('Release artifact source evidence is missing or invalid. Rebuild with source identity evidence.');
  return JSON.stringify([source.commit, source.dirty, source.contentSha256]);
}

/** Explicit whitelist: private staging/executable paths and arbitrary fields never reach release assets. */
export function publicReleaseEvidence(record) {
  sourceIdentityKey(record.source);
  if (!['win32', 'darwin'].includes(record.platform) || !['x64', 'arm64'].includes(record.arch) || !/^\d+\.\d+\.\d+$/.test(record.version ?? '') || typeof record.node !== 'string' || !/^v\d+\.\d+\.\d+$/.test(record.node) || record.validation !== false)
    throw new Error('Release artifact runtime evidence is invalid or belongs to validation mode.');
  const artifacts = record.installerArtifacts;
  if (!Array.isArray(artifacts) || !artifacts.length) throw new Error('Release evidence requires installer artifacts.');
  return {
    schemaVersion: 1,
    source: { commit: record.source.commit, dirty: record.source.dirty, contentSha256: record.source.contentSha256 },
    version: record.version, platform: record.platform, arch: record.arch, node: record.node,
    validation: false,
    installerArtifacts: artifacts.map((artifact) => {
      const filename = typeof artifact.path === 'string' ? artifact.path.replaceAll('\\', '/') : '';
      if (!filename || filename.startsWith('/') || filename.split('/').some((part) => !part || part === '.' || part === '..' || part.includes(':')) || !/\.(exe|msi|dmg|pkg)$/i.test(filename) || !Number.isSafeInteger(artifact.size) || artifact.size < 0 || !digest.test(artifact.sha256 ?? ''))
        throw new Error('Release evidence contains an invalid installer identity.');
      return { path: filename, size: artifact.size, sha256: artifact.sha256 };
    }),
  };
}
