import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildLocalAgentEnv, resolveLaunchCommand } from './local-agent-runtime.js';

test('legacy unquoted absolute paths resolve as one executable before tokenization', async () => {
  const executable = String.raw`C:\Program Files\My Agent\launch.exe`;
  const calls: string[] = [];
  const resolved = await resolveLaunchCommand(executable, async (file) => {
    calls.push(file);
    return file === executable ? { file } : null;
  });
  assert.deepEqual(resolved, { file: executable, args: [] });
  assert.deepEqual(calls, [executable]);
  const script = String.raw`C:\Program Files\My Agent\launch.cmd`;
  const scriptCalls: string[] = [];
  assert.equal(await resolveLaunchCommand(script, async (file) => {
    scriptCalls.push(file);
    return { file };
  }), null);
  assert.deepEqual(scriptCalls, [script], 'an unsupported existing script never falls back to a different executable');
});

test('quoted executable paths and explicit interpreters preserve every prefix argument', async () => {
  assert.deepEqual(await resolveLaunchCommand('"/opt/Custom Agent/launch" --config ""', async (file) => ({ file })), {
    file: '/opt/Custom Agent/launch', args: ['--config', ''],
  });
  assert.deepEqual(await resolveLaunchCommand('pwsh -File "agent wrapper.ps1"', async () => ({ file: 'C:/tools/pwsh.exe' })), {
    file: 'C:/tools/pwsh.exe', args: ['-File', 'agent wrapper.ps1'],
  });
  assert.equal(await resolveLaunchCommand('agent.ps1', async () => ({ file: 'C:/tools/agent.ps1' })), null);
  assert.equal(await resolveLaunchCommand('agent.cmd', async () => ({ file: 'C:/tools/agent.cmd' })), null);
});

test('native tool and billing configuration stays intact while app-internal values are removed', () => {
  assert.deepEqual(buildLocalAgentEnv({ OPENAI_API_KEY: 'native-key', ANTHROPIC_AUTH_TOKEN: 'native-token', CUSTOM_MCP_TOKEN: 'tool-token', NODE_OPTIONS: '--trace-warnings', PULSE_METRIC_STUDIO_MACHINE_KEY: 'private', pulse_metric_studio_secret: 'private', absent: undefined }), {
    OPENAI_API_KEY: 'native-key', ANTHROPIC_AUTH_TOKEN: 'native-token', CUSTOM_MCP_TOKEN: 'tool-token', NODE_OPTIONS: '--trace-warnings',
  });
});
