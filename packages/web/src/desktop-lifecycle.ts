import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

const stoppedMessage = 'Pulse stopped responding. Restart Pulse Metric Studio to continue.';
type Payload = { message?: string };
type Stop = () => void;
interface LifecycleEvents {
  native(): boolean;
  listen(handler: (payload: Payload) => void): Promise<Stop>;
}
const nativeEvents: LifecycleEvents = {
  native: isTauri,
  listen: (handler) => listen<Payload>('pulse-backend-unavailable', (event) => handler(event.payload)),
};

/** Own the native subscription, including cleanup before asynchronous registration completes. */
export function subscribeBackendUnavailable(
  onUnavailable: (message: string) => void,
  events: LifecycleEvents = nativeEvents,
): Stop {
  if (!events.native()) return () => {};
  let disposed = false;
  let stop: Stop | undefined;
  void events.listen((payload) => {
    if (!disposed) onUnavailable(payload?.message || stoppedMessage);
  }).then((unsubscribe) => {
    if (disposed) unsubscribe();
    else stop = unsubscribe;
  }).catch(() => {
    if (!disposed) onUnavailable('The desktop connection could not be initialized. Restart Pulse Metric Studio to continue.');
  });
  return () => {
    disposed = true;
    stop?.();
    stop = undefined;
  };
}
