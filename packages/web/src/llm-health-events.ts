/**
 * Lightweight window-event signal for assistant (LLM) health, so the readiness
 * dot reflects ACTUAL usage instead of polling the status endpoint on a timer.
 *
 * The badge loads status once on mount (and again when its settings modal opens
 * or a provider is saved/tested/selected). Beyond that, the only thing that
 * changes real-world readiness is sending a chat request. Either outcome
 * refreshes the authoritative backend readiness. Controllers emit this after
 * a send resolves.
 */
export const LLM_HEALTH_EVENT = 'llm-health';

export interface LlmHealthDetail {
  ok: boolean;
}

export function notifyLlmHealth(ok: boolean): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<LlmHealthDetail>(LLM_HEALTH_EVENT, { detail: { ok } }));
}
