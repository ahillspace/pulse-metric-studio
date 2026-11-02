import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLaunchCommand } from './local-launch-command.js';
import { LlmProfileWriteSchema } from './llm-contracts.js';

test('launch commands preserve native prefix flags and empty quoted options', () => {
  assert.deepEqual(parseLaunchCommand('  codex --sandbox read-only  '), { file: 'codex', args: ['--sandbox', 'read-only'] });
  assert.deepEqual(parseLaunchCommand('claude --safe-mode --setting-sources ""'), { file: 'claude', args: ['--safe-mode', '--setting-sources', ''] });
});

test('quoted and partially quoted Windows paths retain their backslashes', () => {
  assert.deepEqual(parseLaunchCommand(String.raw`C:\Users\"Example User"\tools\codex.exe --sandbox read-only`), {
    file: String.raw`C:\Users\Example User\tools\codex.exe`, args: ['--sandbox', 'read-only'],
  });
  assert.deepEqual(parseLaunchCommand(String.raw`"C:\Program Files\Local Agent\launch.exe" --config 'C:\Users\Example User\agent.json'`), {
    file: String.raw`C:\Program Files\Local Agent\launch.exe`, args: ['--config', String.raw`C:\Users\Example User\agent.json`],
  });
});

test('JSON, escaped quotes, shell-looking values, and explicit interpreters remain literal arguments', () => {
  assert.deepEqual(parseLaunchCommand(String.raw`claude --settings '{"permissionMode":"default"}' --name "a \"quoted\" value"`), {
    file: 'claude', args: ['--settings', '{"permissionMode":"default"}', '--name', 'a "quoted" value'],
  });
  assert.deepEqual(parseLaunchCommand('pwsh -File "agent wrapper.ps1" "$env:HOME" $(whoami) && echo'), {
    file: 'pwsh', args: ['-File', 'agent wrapper.ps1', '$env:HOME', '$(whoami)', '&&', 'echo'],
  });
});

test('blank executables, unclosed quotes, and control characters fail before launch', () => {
  for (const command of ['', '  ', '"" --flag', 'codex "unclosed', "claude 'unclosed", 'codex\n--sandbox', 'codex\0']) {
    assert.throws(() => parseLaunchCommand(command));
  }
});

test('all local profile families accept configurable executable names, prefix options, and explicit wrappers', () => {
  for (const protocol of ['codex-cli', 'claude-code', 'opencode'] as const) {
    const base = { id: 'local', label: 'Local', protocol, authMode: protocol === 'opencode' ? 'none' : 'local-account', model: 'chosen-model' };
    for (const command of ['custom-agent --sandbox read-only', 'pwsh -File "agent wrapper.ps1"', String.raw`C:\Program Files\Agent\launch.exe`]) {
      assert.equal(LlmProfileWriteSchema.safeParse({ ...base, command }).success, true, command);
    }
    assert.equal(LlmProfileWriteSchema.safeParse({ ...base, command: 'agent "unclosed' }).success, false);
    assert.equal(LlmProfileWriteSchema.safeParse({ ...base, command: '"" --flag' }).success, false);
  }
});

test('legacy absolute executable paths with apostrophes and spaces remain editable without accepting malformed prefix commands', () => {
  for (const [protocol, executable] of [['codex-cli', 'codex'], ['claude-code', 'claude'], ['opencode', 'opencode']] as const) {
    const base = { id: 'legacy', label: 'Legacy', protocol, authMode: protocol === 'opencode' ? 'none' : 'local-account', model: 'fixture-model' };
    const windowsPath = "C:\\Users\\O'Brien\\Local Agent\\" + executable + '.exe';
    const windowsExecutable = 'C:\\tools\\' + executable + '.exe';
    for (const command of [windowsPath, `/opt/O'Brien/Local Agent/${executable}`]) {
      assert.equal(LlmProfileWriteSchema.safeParse({ ...base, command }).success, true, command);
    }
    for (const command of [
      windowsExecutable + " --config 'unfinished",
      windowsExecutable + String.raw` --config 'C:\broken\config.exe`,
      windowsExecutable + String.raw` 'C:\broken\config.exe`,
      windowsPath.replace('Local Agent', 'Local "Agent'),
      `C:\\Users\\O'Brien\\Local\nAgent\\${executable}.exe`,
      `/opt/${executable} '/opt/broken/config`,
    ]) assert.equal(LlmProfileWriteSchema.safeParse({ ...base, command }).success, false, command);
  }
});
