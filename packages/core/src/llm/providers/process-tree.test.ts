import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { collectProcessOutput, killProcessTree, OWN_PROCESS_GROUP, ProcessOutputError } from './process-tree.js';

test('process output preserves UTF-8 across chunks and drains pipes after exit', async () => {
  const child = spawn(process.execPath, ['-e', 'process.stdout.write(Buffer.from([0xe2]));setTimeout(()=>process.stdout.write(Buffer.from([0x82,0xac])),20)'], { stdio: 'pipe', detached: OWN_PROCESS_GROUP, windowsHide: true });
  assert.deepEqual(await collectProcessOutput(child, { input: '', timeoutMs: 3000 }), { stdout: '€', stderr: '', code: 0 });
});

test('process abort terminates the real child and settles after closure', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'pipe', detached: OWN_PROCESS_GROUP, windowsHide: true });
  const controller = new AbortController();
  const pending = collectProcessOutput(child, { input: '', timeoutMs: 3000, signal: controller.signal });
  const rejected = assert.rejects(pending, (error: any) => error.name === 'AbortError');
  controller.abort();
  await rejected;
  assert.ok(child.exitCode !== null || child.signalCode !== null);
});

test('process timeout and stderr output limits stop the child', async () => {
  for (const [script, timeoutMs, kind] of [
    ['setInterval(()=>{},1000)', 25, 'timeout'],
    ['process.stderr.write("x".repeat(150000));setInterval(()=>{},1000)', 3000, 'output_limit'],
  ] as const) {
    const child = spawn(process.execPath, ['-e', script], { stdio: 'pipe', detached: OWN_PROCESS_GROUP, windowsHide: true });
    await assert.rejects(collectProcessOutput(child, { input: '', timeoutMs }), (error) => error instanceof ProcessOutputError && error.kind === kind);
    assert.ok(child.exitCode !== null || child.signalCode !== null);
  }
});

test('process spawn failure is classified without waiting for the deadline', async () => {
  const child = spawn('pulse-no-such-executable-for-test', [], { stdio: 'pipe', detached: OWN_PROCESS_GROUP, windowsHide: true });
  await assert.rejects(collectProcessOutput(child, { input: '', timeoutMs: 3000 }), (error) => error instanceof ProcessOutputError && error.kind === 'spawn');
});

test('POSIX group termination still kills a descendant holding pipes after its parent exits', { skip: process.platform === 'win32' }, async () => {
  const script = 'const {spawn}=require("node:child_process");const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:["ignore",1,2]});console.log(child.pid);child.unref()';
  const parent = spawn(process.execPath, ['-e', script], { stdio: 'pipe', detached: true });
  let descendant = 0;
  const identified = new Promise<void>((resolve) => parent.stdout.once('data', (data) => { descendant = Number(String(data).trim()); resolve(); }));
  const exited = new Promise<void>((resolve) => parent.once('exit', () => resolve()));
  const pending = collectProcessOutput(parent, { input: '', timeoutMs: 5000 });
  try {
    await Promise.all([identified, exited]);
    assert.equal(parent.exitCode, 0);
    assert.ok(descendant > 0);
    killProcessTree(parent);
    assert.equal((await pending).code, 0);
    assert.equal(parent.stdout.destroyed, true);
  } finally {
    killProcessTree(parent);
    if (descendant) { try { process.kill(descendant, 'SIGKILL'); } catch {} }
  }
});
