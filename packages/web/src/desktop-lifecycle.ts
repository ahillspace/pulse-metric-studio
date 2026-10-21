import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

const stoppedMessage = 'Pulse stopped responding. Restart Pulse Metric Studio to continue.';
type Payload = { message?: string };
type Stop = () => void;
interface LifecycleEvents {
  native(): boolean;
  listen(event: 'pulse-backend-unavailable' | 'pulse-shutdown-requested', handler: (payload: Payload) => void): Promise<Stop>;
  shutdown(action: 'ready' | 'complete' | 'cancel'): Promise<void>;
}
const nativeEvents: LifecycleEvents = {
  native: isTauri,
  listen: (event, handler) => listen<Payload>(event, (message) => handler(message.payload)),
  shutdown: (action) => invoke('pulse_shutdown', { action }),
};

/** Native exits drain draft changes; browser exits warn while work remains unsaved. */
export function subscribeDesktopLifecycle(
  callbacks: {
    onUnavailable(message: string): void;
    prepareClose(): Promise<void>;
    cancelClose(): void;
    onCloseError(error: unknown): void;
    hasUnsavedChanges(): boolean;
  },
  events: LifecycleEvents = nativeEvents,
  browser: Pick<Window, 'addEventListener' | 'removeEventListener'> = window,
): Stop {
  let disposed = false;
  let closing = false;
  const stops: Stop[] = [];
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (!callbacks.hasUnsavedChanges()) return;
    event.preventDefault();
    event.returnValue = '';
  };
  browser.addEventListener('beforeunload', beforeUnload as EventListener);
  if (events.native()) {
    for (const event of ['pulse-backend-unavailable', 'pulse-shutdown-requested'] as const) {
      void events.listen(event, (payload) => {
        if (disposed) return;
        if (event === 'pulse-backend-unavailable') {
          callbacks.onUnavailable(payload?.message || stoppedMessage);
          return;
        }
        if (closing) return;
        closing = true;
        void (async () => {
          try {
            await callbacks.prepareClose();
            if (!disposed) await events.shutdown('complete');
          } catch (error) {
            if (!disposed) {
              callbacks.cancelClose();
              if (error instanceof DOMException && error.name === 'AbortError') {
                try { await events.shutdown('cancel'); }
                catch { callbacks.onUnavailable('The desktop could not cancel closing. Restart Pulse Metric Studio after saving your work.'); }
              }
              callbacks.onCloseError(error);
            }
          } finally {
            closing = false;
          }
        })();
      }).then(async (unsubscribe) => {
        if (disposed) unsubscribe();
        else {
          stops.push(unsubscribe);
          if (event === 'pulse-shutdown-requested') await events.shutdown('ready');
        }
      }).catch(() => {
        if (!disposed) callbacks.onUnavailable('The desktop connection could not be initialized. Restart Pulse Metric Studio to continue.');
      });
    }
  }
  return () => {
    if (disposed) return;
    disposed = true;
    if (closing) callbacks.cancelClose();
    browser.removeEventListener('beforeunload', beforeUnload as EventListener);
    for (const stop of stops) stop();
    stops.length = 0;
  };
}
