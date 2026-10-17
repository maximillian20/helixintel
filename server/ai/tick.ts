import { autoEnrich } from './enrich';
import { briefingDue, generateBriefing } from './briefing';
import type { AiDeps } from './common';

export type TickState = { backoffUntil: number; briefingBackoff: Map<string, number>; lastPrune: number };

export const newTickState = (): TickState => ({ backoffUntil: 0, briefingBackoff: new Map(), lastPrune: 0 });

/**
 * Background AI work, run by the same one-minute scheduler pattern as the market and map ticks. It does nothing unless the
 * model is connected and idle, makes small batches, and backs off after a failure so an offline computer costs nothing.
 */
export async function aiTick(deps: AiDeps, state: TickState, publish: (event: string, payload: unknown) => void): Promise<void> {
  const nowMs = deps.now.getTime();
  if (nowMs - state.lastPrune > 6 * 3_600_000) {
    state.lastPrune = nowMs;
    try { deps.aiStore.prune(); } catch (error) { console.warn('[ai] prune failed', error instanceof Error ? error.message : error); }
  }
  if (!deps.ai.config.enabled || !deps.ai.config.baseUrl || nowMs < state.backoffUntil) return;

  try {
    const result = await autoEnrich(deps);
    if (result.done > 0) publish('ai-updated', { kind: 'enrichment', count: result.done });
    if (result.stopped && !['off', 'busy', 'ready'].includes(result.stopped) && result.done === 0 && !['disabled', 'setup_required', 'unreachable', 'model_missing'].includes(result.stopped)) state.backoffUntil = nowMs + 10 * 60_000;
  } catch (error) {
    state.backoffUntil = nowMs + 10 * 60_000;
    console.warn('[ai] automatic summaries failed', error instanceof Error ? error.message : error);
  }

  for (const clientId of deps.aiStore.clientsWithBriefings()) {
    const settings = deps.aiStore.getSettings(clientId);
    if (!briefingDue(settings, deps.now) || nowMs < (state.briefingBackoff.get(clientId) ?? 0)) continue;
    const status = await deps.ai.status();
    if (status.state !== 'ready' || status.queue.running > 0) continue;
    try {
      const result = await generateBriefing(deps, { clientId, name: 'Scheduled briefing' }, { scheduled: true });
      if (result.generated) publish('alerts-updated', {});
    } catch (error) {
      state.briefingBackoff.set(clientId, nowMs + 15 * 60_000);
      console.warn('[ai] scheduled briefing failed', error instanceof Error ? error.message : error);
    }
  }
}
