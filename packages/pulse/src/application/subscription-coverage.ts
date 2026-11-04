import { getSessionContext, type TableauSession } from '@pulse-metric-studio/core';
import type { SubscriptionRecord } from '../pulse/pulse-client.js';
import type { SubscriptionDependencies } from './registry-dependencies.js';
import { getInventoryView } from './inventory-snapshots.js';

interface TargetCoverage { records: SubscriptionRecord[]; complete: boolean; token?: string; seen: Set<string>; pages: number; scanned: number; version: number; demanded: boolean; terminal?: boolean; pending?: Promise<void>; error?: unknown }
interface ViewCoverage {
  scope: 'site' | 'user'; metricIds: Set<string>; siteEligible: Set<string>; site: TargetCoverage; discovered: boolean; discovery?: Promise<void>;
  targeted: Map<string, TargetCoverage>; invalidated: Set<string>;
}
interface CoverageStore { owner: ReturnType<typeof getSessionContext>; coordinates: string; views: Map<string, ViewCoverage> }
const stores = new WeakMap<TableauSession, Map<object, CoverageStore>>();
function fresh(): TargetCoverage { return { records: [], complete: false, seen: new Set(), pages: 0, scanned: 0, version: 0, demanded: false }; }
export function invalidateSubscriptionCoverage(session: TableauSession, metricIds: string[]): void {
  for (const store of stores.get(session)?.values() ?? []) for (const view of store.views.values()) for (const id of metricIds) {
    view.invalidated.add(id); const target = view.targeted.get(id); if (target) target.version++;
    view.targeted.delete(id);
  }
}
export async function subscriptionCoverage(session: TableauSession, metricIds: string[], options: { snapshotId?: string; continueCoverage?: boolean; personalOnly?: boolean }, dependencies: SubscriptionDependencies): Promise<{ entries: Array<{ metricId: string; subscriptions: SubscriptionRecord[] | null; complete: boolean; diagnostic?: { message: string } }>; coverage: { status: 'available' | 'partial' | 'unavailable'; canLoadMore: boolean } }> {
  const owner = getSessionContext(session), coordinates = JSON.stringify([session.serverUrl, session.siteId, session.userId]);
  const sessionStores = stores.get(session) ?? new Map<object, CoverageStore>(); stores.set(session, sessionStores);
  let store = sessionStores.get(dependencies);
  if (!store || store.owner !== owner || store.coordinates !== coordinates) { store = { owner, coordinates, views: new Map() }; sessionStores.set(dependencies, store); }
  const inventory = options.snapshotId ? getInventoryView(session, options.snapshotId) : undefined;
  const key = inventory?.viewId ?? 'legacy';
  let view = store.views.get(key);
  if (!view) { const ids = inventory?.metricIds ?? metricIds; view = { scope: options.personalOnly ? 'user' : 'site', metricIds: new Set(ids), siteEligible: new Set(ids), site: fresh(), discovered: false, targeted: new Map(), invalidated: new Set() }; store.views.set(key, view); while (store.views.size > 8) store.views.delete(store.views.keys().next().value!); }
  if (inventory) {
    if (metricIds.some(id => !inventory.metricIds.includes(id))) throw new Error('Requested subscriptions do not belong to the retained datasource inventory.');
    view.metricIds = new Set(inventory.metricIds);
    view.site.records = view.site.records.filter(record => record.metricId && view!.metricIds.has(record.metricId));
    for (const id of view.targeted.keys()) if (!view.metricIds.has(id)) view.targeted.delete(id);
  } else for (const id of metricIds) view.metricIds.add(id);
  const captured = view;
  const current = () => owner === getSessionContext(session) && coordinates === JSON.stringify([session.serverUrl, session.siteId, session.userId]);
  let calls = 0;
  const canSend = () => { if (!current()) throw new Error('The Tableau session changed while subscription coverage was loading.'); if (calls >= 20) return false; calls++; return true; };
  async function page(target: TargetCoverage, metricId?: string): Promise<void> {
    if (target.pending) return target.pending;
    if (target.complete || target.terminal || target.pages >= 20 || target.scanned >= 2000 || !canSend()) return;
    const version = target.version;
    target.pending = (async () => {
      try {
        if (!dependencies.listSubscriptionPage) {
          if (!metricId) return;
          const records = await dependencies.listSubscriptions(session, metricId);
          if (version === target.version && current()) { target.records = records; target.complete = true; target.pages++; }
          return;
        }
        const result = await dependencies.listSubscriptionPage(session, { ...(metricId ? { metricId } : {}), ...(captured.scope === 'user' && !metricId ? { userId: session.userId } : {}), ...(target.token ? { pageToken: target.token } : {}) });
        if (version !== target.version || !current()) return;
        target.pages++; target.scanned += result.subscriptions.length; target.error = undefined;
        const records = result.subscriptions.filter(record => metricId || (record.metricId && captured.metricIds.has(record.metricId)));
        // Site limits apply to scanned records, even though unrelated identities are not retained.
        target.records.push(...records);
        if (!result.nextPageToken) { target.complete = true; target.token = undefined; return; }
        if (target.seen.has(result.nextPageToken) || !result.subscriptions.length) { target.error = new Error('Subscription continuation is invalid.'); target.token = undefined; target.terminal = true; return; }
        target.seen.add(result.nextPageToken); target.token = result.nextPageToken;
      } catch (error) { if (version === target.version) target.error = error; }
    })().finally(() => { target.pending = undefined; });
    return target.pending;
  }
  if (!view.discovered) {
    if (!view.discovery) view.discovery = page(view.site).finally(() => { view!.discovered = true; view!.discovery = undefined; });
    await view.discovery;
  }
  if (options.continueCoverage && dependencies.listSubscriptionPage) while (view.site.token && !view.site.complete && calls < 20 && view.site.pages < 20) {
    const previous = view.site.pages; await page(view.site); if (view.site.error || previous === view.site.pages) break;
  }
  const qualified = (view.scope === 'site' && dependencies.siteNegativeCoverageQualified === true) || options.personalOnly === true;
  const entries = [];
  for (const metricId of metricIds) {
    if (qualified && view.site.complete && view.siteEligible.has(metricId) && !view.invalidated.has(metricId)) {
      entries.push({ metricId, subscriptions: view.site.records.filter(record => record.metricId === metricId), complete: true }); continue;
    }
    let target = view.targeted.get(metricId);
    if (!target) { target = fresh(); view.targeted.set(metricId, target); }
    if (!target.complete && ((!target.demanded && !target.error) || target.pending || options.continueCoverage)) {
      target.demanded = true;
      do { const previous = target.pages; await page(target, metricId); if (target.error || previous === target.pages) break; } while (target.token && !target.complete && calls < 20);
    }
    const positive = view.invalidated.has(metricId) ? [] : view.site.records.filter(record => record.metricId === metricId);
    const records = target.complete ? target.records : [...positive, ...target.records];
    const hasEvidence = target.complete || records.length > 0;
    entries.push({ metricId, subscriptions: hasEvidence ? records : null, complete: target.complete, ...(!target.complete ? { diagnostic: { message: target.error instanceof Error ? target.error.message : 'Subscription coverage is partial. Load more follow details to continue.' } } : {}) });
  }
  if (!current()) throw new Error('The Tableau session changed while subscription coverage was loading.');
  const complete = entries.every(entry => entry.complete);
  const canLoadMore = Boolean(view.site.token && view.site.pages < 20) || entries.some(entry => !entry.complete && !view!.targeted.get(entry.metricId)?.terminal && (view!.targeted.get(entry.metricId)?.pages ?? 0) < 20);
  return { entries, coverage: { status: complete ? 'available' : entries.some(entry => entry.subscriptions) ? 'partial' : 'unavailable', canLoadMore } };
}
