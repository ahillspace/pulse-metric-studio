import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

/** What the desktop updater knows; see src-tauri/src/updater.rs. */
export interface UpdateStatus {
  currentVersion: string;
  /** A newer release from the repository this copy was installed from. */
  availableVersion: string | null;
  /** Why the previous update attempt did not finish. */
  lastError: string | null;
}
type Stop = () => void;
export interface UpdateEvents {
  native(): boolean;
  listen(handler: (status: UpdateStatus) => void): Promise<Stop>;
  status(): Promise<UpdateStatus>;
  apply(): Promise<void>;
}
export const nativeUpdates: UpdateEvents = {
  native: isTauri,
  listen: (handler) => listen<UpdateStatus>('pulse-update-status', (event) => handler(event.payload)),
  status: () => invoke<UpdateStatus>('pulse_update_status'),
  apply: () => invoke('pulse_update_apply'),
};

/** Reports the update status now and whenever the desktop's daily check changes it. */
export function subscribeUpdates(onStatus: (status: UpdateStatus) => void, events: UpdateEvents = nativeUpdates): Stop {
  if (!events.native()) return () => {};
  let disposed = false;
  let stop: Stop | null = null;
  // Listen before asking, so a check that finishes in between is not missed.
  void events.listen((status) => { if (!disposed) onStatus(status); })
    .then(async (unsubscribe) => {
      if (disposed) { unsubscribe(); return; }
      stop = unsubscribe;
      const status = await events.status();
      if (!disposed) onStatus(status);
    })
    .catch(() => {});
  return () => {
    disposed = true;
    stop?.();
  };
}

/** The launch prompt appears once per newly found version; the rail button stays until it is installed. */
export function shouldPrompt(status: UpdateStatus | null, promptedVersion: string | null): boolean {
  return Boolean(status?.availableVersion) && status!.availableVersion !== promptedVersion;
}
