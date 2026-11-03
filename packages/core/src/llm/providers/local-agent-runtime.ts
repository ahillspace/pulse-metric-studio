import os from 'node:os';
import path from 'node:path';
import { parseLaunchCommand, type LocalLaunchCommand } from '@pulse-metric-studio/shared';

export { parseLaunchCommand } from '@pulse-metric-studio/shared';

/** Preserve native CLI configuration and credentials without app-internal environment values. */
export function buildLocalAgentEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([name, value]) => value !== undefined && !name.toUpperCase().startsWith('PULSE_METRIC_STUDIO_')));
}

export function localAgentCwd(): string { return os.homedir(); }

/** Keep legacy unquoted absolute executable paths working before parsing prefix options. */
export async function resolveLaunchCommand(
  command: string,
  resolver: (file: string) => Promise<{ file: string } | null>,
): Promise<LocalLaunchCommand | null> {
  const raw = command.trim();
  if (path.isAbsolute(raw) || path.win32.isAbsolute(raw)) {
    const legacy = await resolver(raw);
    if (legacy) return directlyExecutable(legacy.file) ? { file: legacy.file, args: [] } : null;
  }
  const parsed = parseLaunchCommand(raw);
  const resolved = await resolver(parsed.file);
  return resolved && directlyExecutable(resolved.file) ? { file: resolved.file, args: parsed.args } : null;
}

function directlyExecutable(file: string): boolean {
  return !/\.(?:cmd|bat|ps1)$/i.test(file);
}

/** Bound executable resolution by the same deadline and cancellation as the operation. */
export async function resolveLaunchWithinDeadline(
  command: string,
  resolver: (file: string) => Promise<{ file: string } | null>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<LocalLaunchCommand | null> {
  const timeout = AbortSignal.timeout(Math.max(0, Math.ceil(timeoutMs)));
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  combined.throwIfAborted();
  let abort: (() => void) | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    abort = () => reject(combined.reason);
    combined.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([resolveLaunchCommand(command, resolver), stopped]); }
  finally { if (abort) combined.removeEventListener('abort', abort); }
}
