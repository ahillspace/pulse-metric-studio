import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const shellCandidates = process.platform === 'win32'
  ? [path.join(process.env.ProgramFiles ?? '', 'Git', 'bin', 'sh.exe')]
  : ['/bin/sh'];
const shell = shellCandidates.find((candidate) => fs.existsSync(candidate));
const powershell = 'powershell.exe';
// These fixtures exercise real Windows path resolution and temporary files.
// PowerShell on another OS cannot supply those filesystem semantics.
const hasPowerShell = process.platform === 'win32'
  && !spawnSync(powershell, ['-NoProfile', '-Command', 'exit 0']).error;

const shellHarness = `
waits=0
running=1
[ "$TEST_CLOSE" != closed ] || running=0
record() { printf '%s\\n' "$1" >> events; }
uname() { if [ "$1" = -s ]; then echo Darwin; else echo arm64; fi; }
pgrep() {
    [ "$TEST_CLOSE" != success ] || [ "$waits" -lt 2 ] || running=0
    [ "$running" -eq 1 ]
}
osascript() { record close; [ "$TEST_CLOSE" != rejected ]; }
sleep() { waits=$((waits + 1)); record wait; }
pkill() { record force-stop; running=0; }
open() { record launch; }
xattr() { :; }
curl() {
    case "$*" in
        *url_effective*) echo https://example.invalid/releases/tag/v1.2.3 ;;
        *)
            while [ "$1" != -o ]; do shift; done
            shift
            case "$1" in
                *checksums.txt) printf 'abc  Pulse-Metric-Studio_1.2.3_aarch64.dmg\\n' > "$1" ;;
                *) printf image > "$1" ;;
            esac
            ;;
    esac
}
shasum() { printf 'abc  fixture\\n'; }
hdiutil() {
    [ "$1" = attach ] || return 0
    while [ "$1" != -mountpoint ]; do shift; done
    shift
    mkdir -p "$1/Pulse Metric Studio.app"
    printf new > "$1/Pulse Metric Studio.app/version"
}
ditto() { record copy; cp -R "$1" "$2"; }
mv() { record replace; command mv "$@"; }
set -- "$TEST_ACTION" --install-dir ./apps --no-launch
[ "$TEST_UPDATE" != 1 ] || set -- "$@" --update
. "$TEST_INSTALLER"
`;

const powershellHarness = `
$ErrorActionPreference = 'Stop'
$global:running = $env:TEST_CLOSE -ne 'closed'
function Record([string]$message) { Add-Content -LiteralPath 'events' -Value $message }
function Get-Process {
    if ($global:running) {
        $process = [pscustomobject]@{ Id = 12345 }
        $process | Add-Member ScriptMethod CloseMainWindow {
            Record 'close'
            if ($env:TEST_CLOSE -eq 'request-error') { throw 'Close request failed' }
            return $true
        }
        $process
    }
}
function Wait-Process {
    [CmdletBinding()] param([Parameter(ValueFromPipeline)]$InputObject, $Timeout)
    process {
        Record 'wait'
        if ($env:TEST_CLOSE -eq 'success') { $global:running = $false }
    }
}
function Stop-Process {
    [CmdletBinding()] param([Parameter(ValueFromPipeline)]$InputObject, [switch]$Force)
    process { Record 'force-stop'; $global:running = $false }
}
function Get-ItemProperty {
    param($LiteralPath, $ErrorAction)
    if ($env:TEST_FAILURE -eq 'registry') { throw 'private registry detail' }
    if ($env:TEST_REGISTERED -eq '1' -and $LiteralPath -like 'HKCU:*') { return [pscustomobject]@{ InstallLocation = $env:TEST_CUSTOM_DIR } }
    return $null
}
function New-Item {
    param($ItemType, $Path, [switch]$Force)
    if ($env:TEST_FAILURE -eq 'filesystem' -and $Path -like '*pulse-metric-studio-install-*') { throw 'private file detail' }
    Microsoft.PowerShell.Management\\New-Item -ItemType $ItemType -Path $Path -Force:$Force
}
function Invoke-WebRequest {
    param($Uri, $Method, [switch]$UseBasicParsing, $TimeoutSec, $OutFile)
    if ($Method -eq 'Head') {
        return [pscustomobject]@{ BaseResponse = [pscustomobject]@{ ResponseUri = 'https://example.invalid/releases/tag/v1.2.3' } }
    }
    if ($OutFile -like '*checksums.txt') {
        $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path (Split-Path $OutFile) 'Pulse-Metric-Studio_1.2.3_x64-setup.exe')).Hash
        Set-Content -LiteralPath $OutFile -Value "$hash  Pulse-Metric-Studio_1.2.3_x64-setup.exe"
    } else { Set-Content -LiteralPath $OutFile -Value 'fixture' }
}
function Start-Process {
    param($FilePath, $ArgumentList, [switch]$Wait, [switch]$PassThru, $WindowStyle)
    if ($FilePath -like '*setup.exe' -or $FilePath -like '*uninstall.exe') {
        if ($WindowStyle -ne 'Hidden') { throw 'Silent installer must use a hidden window.' }
        Record 'replace'
        if ($env:TEST_FAILURE -eq 'setup') { throw 'private setup detail' }
        $install = if ($env:TEST_CUSTOM_DIR) { $env:TEST_CUSTOM_DIR } else { Join-Path $env:LOCALAPPDATA 'Pulse Metric Studio' }
        if ($env:TEST_ACTION -eq 'Uninstall') {
            if ($ArgumentList[-1] -ne "_?=$install") { throw 'Uninstaller was not bound to the target directory.' }
            if ($env:TEST_UNINSTALL_RESULT -notin @('failed', 'incomplete')) {
                Remove-Item -LiteralPath (Join-Path $install 'version')
                Remove-Item -LiteralPath (Join-Path $install 'pulse-metric-studio.exe')
                Remove-Item -LiteralPath (Join-Path $install 'uninstall.exe')
            }
        } else {
            if ($ArgumentList[-1] -ne "/D=$install") { throw 'Installer was not bound to the target directory.' }
            Set-Content -LiteralPath (Join-Path $install 'version') -Value 'new'
        }
        if ($PassThru) { [pscustomobject]@{ ExitCode = $(if ($env:TEST_UNINSTALL_RESULT -eq 'failed' -or $env:TEST_FAILURE -eq 'setup-exit') { 2 } else { 0 }) } }
    } else {
        Record 'launch'
        if ($env:TEST_FAILURE -eq 'launch') { throw 'private launch detail' }
        if ($env:TEST_CUSTOM_DIR -and $FilePath -eq (Join-Path $env:TEST_CUSTOM_DIR 'pulse-metric-studio.exe')) { Record 'launch-custom' }
    }
}
try {
    $options = @{ Action = $env:TEST_ACTION; NoLaunch = $true }
    if ($env:TEST_UPDATE -eq '1') { $options.Update = $true }
    if ($env:TEST_CUSTOM_DIR -and $env:TEST_REGISTERED -ne '1') {
        $options.InstallDir = if ($env:TEST_INVALID_DIR -eq '1') { Join-Path $env:TEST_CUSTOM_DIR 'missing' } else { $env:TEST_CUSTOM_DIR }
    }
    if ($env:TEST_INVOCATION -eq 'scriptblock') {
        & ([scriptblock]::Create((Get-Content -LiteralPath $env:TEST_INSTALLER -Raw))) @options
    } else {
        & $env:TEST_INSTALLER @options
    }
} catch {
    Write-Output $_.Exception.Message
    exit 23
}
`;

function runInstaller(platform, action, close, update = false, custom = false, uninstallResult = '', registered = false, invalidDir = false, failure = '', invocation = 'file') {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-installer-shutdown-'));
  try {
    const mac = platform === 'macOS';
    const app = mac ? path.join(temporary, 'apps', 'Pulse Metric Studio.app') : custom ? path.join(temporary, 'custom', 'Pulse Metric Studio') : path.join(temporary, 'local', 'Pulse Metric Studio');
    const data = mac ? path.join(temporary, 'Library', 'Application Support', 'com.ahillspace.pulsemetricstudio') : path.join(temporary, 'roaming', 'com.ahillspace.pulsemetricstudio');
    fs.mkdirSync(app, { recursive: true });
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(app, 'version'), 'old');
    fs.writeFileSync(path.join(app, 'uninstall.exe'), 'fixture');
    fs.writeFileSync(path.join(app, 'pulse-metric-studio.exe'), 'fixture');
    fs.writeFileSync(path.join(data, 'update-channel'), 'fixture/channel');
    fs.writeFileSync(path.join(data, 'durable-state'), 'preserve');
    const harness = path.join(temporary, mac ? 'harness.sh' : 'harness.ps1');
    fs.writeFileSync(harness, mac ? shellHarness : powershellHarness);
    const result = spawnSync(mac ? shell : powershell, mac ? ['harness.sh'] : ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness], {
      cwd: temporary,
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        ...process.env,
        HOME: '.', TMPDIR: '.',
        LOCALAPPDATA: path.join(temporary, 'local'), APPDATA: path.join(temporary, 'roaming'),
        TEST_CLOSE: close, TEST_ACTION: action, TEST_UPDATE: update ? '1' : '0',
        TEST_CUSTOM_DIR: custom ? app : '', TEST_UNINSTALL_RESULT: uninstallResult, TEST_REGISTERED: registered ? '1' : '0', TEST_INVALID_DIR: invalidDir ? '1' : '0', TEST_FAILURE: failure,
        TEST_INSTALLER: path.join(root, 'scripts', mac ? 'install.sh' : 'install.ps1').replaceAll('\\', '/'), TEST_INVOCATION: invocation,
      },
    });
    assert.ifError(result.error);
    const events = fs.existsSync(path.join(temporary, 'events')) ? fs.readFileSync(path.join(temporary, 'events'), 'utf8').trim().split(/\r?\n/) : [];
    return {
      status: result.status, output: result.stdout + result.stderr, events,
      version: fs.existsSync(path.join(app, 'version')) ? fs.readFileSync(path.join(app, 'version'), 'utf8').trim() : null,
      channel: fs.existsSync(path.join(data, 'update-channel')),
      updateError: fs.existsSync(path.join(data, 'update-error')) ? fs.readFileSync(path.join(data, 'update-error'), 'utf8') : null,
      durable: fs.readFileSync(path.join(data, 'durable-state'), 'utf8'),
      staged: fs.readdirSync(path.dirname(app)).filter((name) => name.startsWith('.Pulse Metric Studio.app.')),
    };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

for (const failure of ['setup', 'filesystem', 'launch']) {
  test(`Windows update recovers from unexpected ${failure} failure`, { skip: !hasPowerShell }, () => {
    const result = runInstaller('Windows', 'Install', 'closed', true, true, '', false, false, failure);
    assert.notEqual(result.status, 0, result.output);
    assert.equal(result.channel, true);
    assert.match(result.updateError ?? '', /could not complete/i);
    assert.doesNotMatch(result.updateError ?? '', /private/);
    assert.ok(result.events.includes('launch'));
  });
}

test('Windows update recovers when a normal close request throws', { skip: !hasPowerShell }, () => {
  const result = runInstaller('Windows', 'Install', 'request-error', true, true);
  assert.notEqual(result.status, 0, result.output);
  assert.equal(result.channel, true);
  assert.match(result.updateError ?? '', /could not complete/i);
  assert.ok(result.events.includes('launch'));
  assert.equal(result.events.includes('force-stop'), false);
});

for (const invocation of ['file', 'scriptblock']) {
  test(`Windows ${invocation} update preserves the specific failure and runs recovery once`, { skip: !hasPowerShell }, () => {
    const result = runInstaller('Windows', 'Install', 'closed', true, true, '', false, false, 'setup-exit', invocation);
    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, /exited with code 2/i);
    assert.match(result.updateError ?? '', /exited with code 2/i);
    assert.doesNotMatch(result.output, /could not complete the operation/i);
    assert.equal(result.events.filter((event) => event === 'launch').length, 1);
    assert.equal(result.channel, true);
  });

  for (const update of [false, true]) {
    test(`Windows ${invocation} ${update ? 'update' : 'uninstall'} preserves the close diagnostic`, { skip: !hasPowerShell }, () => {
      const result = runInstaller('Windows', update ? 'Install' : 'Uninstall', 'keep-open', update, true, '', false, false, '', invocation);
      assert.notEqual(result.status, 0, result.output);
      assert.match(result.output, /could not finish closing/i);
      assert.doesNotMatch(result.output, /could not complete the operation/i);
      assert.equal(result.events.filter((event) => event === 'launch').length, update ? 1 : 0);
      if (update) assert.match(result.updateError ?? '', /could not finish closing/i);
      else assert.equal(result.updateError, null);
      assert.equal(result.events.includes('replace'), false);
      assert.equal(result.version, 'old');
      assert.equal(result.channel, true);
    });
  }
}

test('Windows latest version lookup ignores local installation registry failures', { skip: !hasPowerShell }, () => {
  const result = runInstaller('Windows', 'LatestVersion', 'closed', false, false, '', false, false, 'registry');
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /1\.2\.3/);
});

test('Windows uninstall retains channel and reports failure when removal fails', { skip: !hasPowerShell }, () => {
  for (const failure of ['failed', 'incomplete']) {
    const result = runInstaller('Windows', 'Uninstall', 'closed', false, false, failure);
    assert.notEqual(result.status, 0, result.output);
    assert.equal(result.version, 'old');
    assert.equal(result.channel, true);
  }
});

test('Windows helper resolves an existing registered custom installation', { skip: !hasPowerShell }, () => {
  const result = runInstaller('Windows', 'Uninstall', 'closed', false, true, '', true);
  assert.equal(result.status, 0, result.output);
  assert.equal(result.version, null);
  assert.equal(result.channel, false);
});

test('Windows helper rejects an invalid explicit installation directory before removal', { skip: !hasPowerShell }, () => {
  const result = runInstaller('Windows', 'Uninstall', 'closed', false, true, '', false, true);
  assert.notEqual(result.status, 0, result.output);
  assert.equal(result.version, 'old');
  assert.equal(result.channel, true);
  assert.equal(result.events.includes('replace'), false);
});

test('Windows custom installation can uninstall and update from its actual directory', { skip: !hasPowerShell }, () => {
  const uninstall = runInstaller('Windows', 'Uninstall', 'closed', false, true);
  assert.equal(uninstall.status, 0, uninstall.output);
  assert.equal(uninstall.version, null);
  const update = runInstaller('Windows', 'Install', 'closed', true, true);
  assert.equal(update.status, 0, update.output);
  assert.equal(update.version, 'new');
  assert.ok(update.events.includes('launch-custom'));
});

for (const platform of ['macOS', 'Windows']) {
  const skip = platform === 'macOS' ? !shell : !hasPowerShell;
  for (const action of ['Install', 'Uninstall']) {
    for (const close of ['delayed', 'rejected', 'keep-open']) {
      test(`${platform} ${action} aborts while automatic close is ${close}`, { skip }, () => {
        const result = runInstaller(platform, platform === 'macOS' ? action.toLowerCase() : action, close);
        assert.notEqual(result.status, 0, result.output);
        assert.match(result.output, /could not finish closing/i);
        assert.equal(result.events.includes('force-stop'), false);
        assert.equal(result.events.includes('replace'), false);
        assert.ok(result.events.includes('close'));
        assert.equal(result.version, 'old');
        assert.equal(result.channel, true);
        assert.equal(result.durable, 'preserve');
        assert.deepEqual(result.staged, []);
      });
    }
    for (const close of ['closed', 'success']) {
      test(`${platform} ${action} continues after automatic close is ${close}`, { skip }, () => {
        const result = runInstaller(platform, platform === 'macOS' ? action.toLowerCase() : action, close);
        assert.equal(result.status, 0, result.output);
        assert.equal(result.events.includes('force-stop'), false);
        assert.equal(result.events.includes('close'), close !== 'closed');
        assert.equal(result.version, action === 'Install' ? 'new' : null);
        assert.equal(result.channel, action === 'Install');
        assert.equal(result.durable, 'preserve');
      });
    }
  }
  test(`${platform} approved in-app update installs and launches without another close`, { skip }, () => {
    const result = runInstaller(platform, platform === 'macOS' ? 'install' : 'Install', 'closed', true);
    assert.equal(result.status, 0, result.output);
    assert.equal(result.version, 'new');
    assert.equal(result.events.includes('close'), false);
    assert.equal(result.events.includes('force-stop'), false);
    assert.ok(result.events.includes('launch'));
  });
}
