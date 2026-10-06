import type { ChildProcess } from 'node:child_process';
import { spawnSync } from 'node:child_process';

/**
 * Spawn option that puts a POSIX child in its own process group, so
 * killProcessTree can stop everything it launched (a shell and its children).
 */
export const OWN_PROCESS_GROUP = process.platform !== 'win32';

/** Stops a child and every descendant; killing only a shell leaves its children running. */
export function killProcessTree(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}
