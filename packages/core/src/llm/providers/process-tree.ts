import type { ChildProcess, ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

/**
 * Spawn option that puts a POSIX child in its own process group, so
 * killProcessTree can stop its process group even after the direct child exits.
 */
export const OWN_PROCESS_GROUP = process.platform !== 'win32';

/** Stop the process group on POSIX, or the live parent's tree on Windows. */
export function killProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    if (child.exitCode !== null || child.signalCode !== null) return;
    spawnSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 3000 });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

export class ProcessOutputError extends Error {
  constructor(readonly kind: 'timeout' | 'output_limit' | 'spawn', options?: ErrorOptions) {
    super(kind, options);
  }
}

/** Settle after child pipes close, with bounded forced cleanup when an executable ignores termination. */
export function collectProcessOutput(
  child: ChildProcessWithoutNullStreams,
  options: { input: string; timeoutMs: number; signal?: AbortSignal; maxBytes?: number; onStdout?: (chunk: string) => void },
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: unknown;
    let settled = false;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const decoder = new StringDecoder('utf8');
    const errorDecoder = new StringDecoder('utf8');
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(cleanupTimer);
      options.signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else resolve({ stdout: stdout + decoder.end(), stderr: stderr + errorDecoder.end(), code });
    };
    const stop = (error: unknown) => {
      if (failure || settled) return;
      failure = error;
      killProcessTree(child);
      // A broken executable must not keep shutdown blocked forever after termination was requested.
      cleanupTimer = setTimeout(() => {
        child.kill('SIGKILL');
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
        child.unref();
        finish(null);
      }, 2000);
    };
    const abort = () => stop(new DOMException('The provider request was cancelled.', 'AbortError'));
    const timer = setTimeout(() => stop(new ProcessOutputError('timeout')), Math.max(1, options.timeoutMs));
    child.stdout.on('data', (data: Buffer) => {
      if (failure || settled) return;
      stdoutBytes += data.length;
      if (stdoutBytes > (options.maxBytes ?? 2_000_000)) return stop(new ProcessOutputError('output_limit'));
      const chunk = decoder.write(data);
      stdout += chunk;
      try { options.onStdout?.(chunk); } catch (error) { stop(error); }
    });
    child.stderr.on('data', (data: Buffer) => {
      if (failure || settled) return;
      stderrBytes += data.length;
      if (stderrBytes > 128_000) return stop(new ProcessOutputError('output_limit'));
      stderr += errorDecoder.write(data);
    });
    child.once('error', (error) => { failure ??= new ProcessOutputError('spawn', { cause: error }); });
    child.once('close', finish);
    child.stdin.on('error', () => {});
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    if (!failure) child.stdin.end(options.input);
    else child.stdin.destroy();
  });
}
