export interface RegistryCooldown { retryAt: number; remainingSeconds: number }

export function CooldownBanner({ cooldown }: { cooldown?: RegistryCooldown | null }) {
  return cooldown ? <p className="warning-banner" role="status" aria-live="polite">{cooldown.remainingSeconds > 0 ? `Tableau is limiting requests. Waiting about ${cooldown.remainingSeconds} seconds.` : "Tableau is limiting requests. Waiting for the next request to complete."}</p> : null;
}
