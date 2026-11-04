import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicReleaseEvidence, sha256File, sourceIdentityKey } from './release-provenance.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// The repository the source install scripts default to; staging rewrites it to the target release repository.
const sourceRepo = 'ahillspace/pulse-metric-studio';
const usage = 'usage: sh scripts/stage-release.sh --repo OWNER/NAME OUTPUT_DIRECTORY [INSTALLER ...]';
function discover(directory, suffix) {
  return fs.existsSync(directory) ? fs.readdirSync(directory).filter((name) => name.endsWith(suffix)).map((name) => path.join(directory, name)) : [];
}
function evidenceFor(installer, version, hash) {
  for (const directory of [path.dirname(installer), path.dirname(path.dirname(installer))]) {
    const filename = path.join(directory, 'release-evidence.json');
    if (!fs.existsSync(filename)) continue;
    if (fs.statSync(filename).size > 1024 * 1024) throw new Error('Release artifact evidence exceeds the local limit.');
    const raw = JSON.parse(fs.readFileSync(filename, 'utf8'));
    const builds = Array.isArray(raw.builds) ? raw.builds : [raw];
    if (builds.length > 32) throw new Error('Release artifact evidence exceeds the local build limit.');
    for (const build of builds) {
      const evidence = publicReleaseEvidence(build);
      if (evidence.version === version && evidence.installerArtifacts.some((item) => path.posix.basename(item.path) === path.basename(installer) && item.sha256 === hash && item.size === fs.statSync(installer).size)) return evidence;
    }
  }
  throw new Error(`Installer ${path.basename(installer)} has no matching sanitized source/hash evidence. Rebuild it or bring its release-evidence.json alongside it.`);
}

export function stageRelease(repository, args) {
  // Every release names its repository: installed copies take their update channel from the staged scripts.
  if (args[0] !== '--repo') throw new Error(`--repo is required. ${usage}`);
  const releaseRepo = args[1];
  args = args.slice(2);
  if (typeof releaseRepo !== 'string' || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(releaseRepo)) throw new Error('--repo must look like OWNER/NAME.');
  if (!args.length) throw new Error(usage);
  const output = path.resolve(args[0]);
  if (fs.existsSync(output) && (fs.lstatSync(output).isSymbolicLink() || !fs.statSync(output).isDirectory() || fs.readdirSync(output).length)) throw new Error('Release output must be an empty directory or a new path.');
  const version = JSON.parse(fs.readFileSync(path.join(repository, 'package.json'), 'utf8')).version;
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error('Release staging requires a numeric three-part version.');
  const inputs = [...discover(path.join(repository, 'native-artifacts/dmg'), '.dmg'), ...discover(path.join(repository, 'native-artifacts/nsis'), '-setup.exe'), ...args.slice(1)];
  const artifacts = new Map();
  for (const input of inputs) {
    if (!fs.existsSync(input) || !fs.statSync(input).isFile()) continue;
    const name = path.basename(input).replaceAll(' ', '-');
    if (!name.startsWith(`Pulse-Metric-Studio_${version}_`) || !/\.(dmg|exe|msi|pkg)$/i.test(name)) continue;
    const hash = sha256File(input);
    const previous = artifacts.get(name);
    if (previous && previous.sha256 !== hash) throw new Error(`Conflicting installer bytes for ${name}; no release files were promoted.`);
    if (previous) previous.inputs.push(input);
    else artifacts.set(name, { name, input, inputs: [input], sha256: hash });
  }
  if (!artifacts.size) throw new Error(`No Pulse Metric Studio ${version} installers found; build them first or pass their paths.`);
  let sourceKey;
  const builds = new Map();
  for (const artifact of artifacts.values()) {
    for (const input of artifact.inputs) {
      const evidence = evidenceFor(input, version, artifact.sha256);
      const key = sourceIdentityKey(evidence.source);
      if (sourceKey && sourceKey !== key) throw new Error('Installers have mixed source identities; no release files were promoted.');
      sourceKey = key;
      const extension = path.extname(artifact.name).toLowerCase();
      if ((extension === '.exe' || extension === '.msi') && evidence.platform !== 'win32' || extension === '.dmg' && evidence.platform !== 'darwin') throw new Error('Installer platform does not match its release evidence.');
      const arch = /_(aarch64|arm64)(?:[_.-])/.test(artifact.name) ? 'arm64' : /_x64(?:[_.-])/.test(artifact.name) ? 'x64' : undefined;
      if (!arch || arch !== evidence.arch) throw new Error('Installer architecture does not match its release evidence.');
      const buildKey = JSON.stringify([evidence.platform, evidence.arch, evidence.node]);
      const retained = builds.get(buildKey) ?? { ...evidence, installerArtifacts: [] };
      if (!retained.installerArtifacts.some((entry) => entry.path === artifact.name)) retained.installerArtifacts.push({ path: artifact.name, sha256: artifact.sha256, size: fs.statSync(input).size });
      builds.set(buildKey, retained);
    }
  }
  const scripts = new Map();
  for (const name of ['install.sh', 'install.ps1']) {
    const script = fs.readFileSync(path.join(repository, 'scripts', name), 'utf8');
    if (!script.includes(sourceRepo)) throw new Error(`scripts/${name} no longer mentions ${sourceRepo}; update stage-release.mjs.`);
    scripts.set(name, script.replaceAll(sourceRepo, releaseRepo).replaceAll('\r\n', '\n'));
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const staged = fs.mkdtempSync(path.join(path.dirname(output), '.pulse-release-stage-'));
  const previous = `${staged}-previous`;
  let promoted = false;
  try {
    for (const artifact of artifacts.values()) {
      const destination = path.join(staged, artifact.name);
      fs.copyFileSync(artifact.input, destination);
      if (sha256File(destination) !== artifact.sha256) throw new Error('Installer changed while release files were copied. No release files were promoted.');
    }
    for (const [name, script] of scripts) fs.writeFileSync(path.join(staged, name), script);
    fs.chmodSync(path.join(staged, 'install.sh'), 0o755);
    fs.writeFileSync(path.join(staged, 'checksums.txt'), [...artifacts.values()].map((item) => `${item.sha256}  ${item.name}\n`).sort().join(''));
    fs.writeFileSync(path.join(staged, 'release-evidence.json'), JSON.stringify({ schemaVersion: 1, source: [...builds.values()][0].source, version, builds: [...builds.values()] }, null, 2));
    if (fs.existsSync(output)) {
      if (fs.lstatSync(output).isSymbolicLink() || fs.readdirSync(output).length) throw new Error('Release output changed while staging; previous files were preserved.');
      fs.renameSync(output, previous);
    }
    try { fs.renameSync(staged, output); promoted = true; }
    catch (error) { if (fs.existsSync(previous)) fs.renameSync(previous, output); throw error; }
    return { version, installers: artifacts.size, output };
  } finally {
    if (fs.existsSync(staged)) fs.rmSync(staged, { recursive: true, force: true });
    if (promoted && fs.existsSync(previous)) fs.rmdirSync(previous);
  }
}

// Compare real paths: a checkout reached through a symlink must still run, not exit silently.
if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try { const result = stageRelease(root, process.argv.slice(2)); console.log(`Staged ${result.installers} verified installers for ${result.version}.`); }
  catch (error) { console.error(`error: ${error.message}`); process.exitCode = 1; }
}
