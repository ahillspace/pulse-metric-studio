/** Transport failures notify the shell; local draft and receipt state is retained. */
export function notifySessionExpired(): void {
  if (typeof window !== "undefined")
    window.dispatchEvent(new Event("pulse-session-expired"));
}
