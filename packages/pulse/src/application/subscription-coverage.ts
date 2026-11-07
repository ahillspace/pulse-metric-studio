import { getSessionContext, TableauError, type TableauSession } from '@pulse-metric-studio/core';
import { PULSE_FOLLOW_DETAIL_BATCH_LIMIT } from '@pulse-metric-studio/shared';
import type { SubscriptionRecord } from '../pulse/pulse-client.js';
import type { SubscriptionDependencies } from './registry-dependencies.js';
import { getInventoryView } from './inventory-snapshots.js';
import { mapWithConcurrency } from './registry-collections.js';

/**
 * Subscription calls one follow-detail request may send: one discovery page plus two pages for each metric
 * in a full client batch. It is derived from the shared batch bound so the client and server always agree and
 * a full batch completes in one request. It is a local work bound, not a Tableau limit; larger demands stop
 * with an explicit Load more instead of growing the request.
 */
export const SUBSCRIPTION_CALLS_PER_REQUEST = 1 + 2 * PULSE_FOLLOW_DETAIL_BATCH_LIMIT;
/**
 * Targeted subscription reads in flight for one request. Small and fixed so one batch cannot crowd out other
 * Tableau work; the client runs only a few detail requests at once and the shared request gate caps the total.
 */
export const SUBSCRIPTION_READ_CONCURRENCY = 5;

interface TargetCoverage { records: SubscriptionRecord[]; complete: boolean; token?: string; seen: Set<string>; pages: number; scanned: number; version: number; demanded: boolean; terminal?: boolean; pending?: Promise<void>; error?: unknown }
interface ViewCoverage {
  scope: 'site' | 'user'; metricIds: Set<string>; siteEligible: Set<string>; site: TargetCoverage; discovered: boolean; discovery?: Promise<void>;
  targeted: Map<string, TargetCoverage>; invalidated: Set<string>;
}
interface CoverageStore { owner: ReturnType<typeof getSessionContext>; coordinates: string; views: Map<string, ViewCoverage> }
const stores = new WeakMap<TableauSession, Map<object, CoverageStore>>();
/** Per-metric invalidation epochs, so a count read before a mutation cannot settle coverage after it. */
const epochs = new WeakMap<TableauSession, Map<string, number>>();
function fresh(): TargetCoverage { return { records: [], complete: false, seen: new Set(), pages: 0, scanned: 0, version: 0, demanded: false }; }
function stopAtLimit(target: TargetCoverage): void {
  target.terminal = true;
  target.error = new Error('Follower list stopped at the local safety limit. Showing the followers found so far.');
}
export function invalidateSubscriptionCoverage(session: TableauSession, metricIds: string[]): void {
  const counter = epochs.get(session) ?? new Map<string, number>(); epochs.set(session, counter);
  for (const id of metricIds) counter.set(id, (counter.get(id) ?? 0) + 1);
  for (const store of stores.get(session)?.values() ?? []) for (const view of store.views.values()) for (const id of metricIds) {
    view.invalidated.add(id); const target = view.targeted.get(id); if (target) target.version++;
    view.targeted.delete(id);
  }
}
const MORE_FOLLOWERS = 'More followers to load. Select Load more followers to continue.';
const identityCount = (records: SubscriptionRecord[]) => new Set(records.map(record => `${record.follower.type}\u0000${record.follower.id}`)).size;

/**
 * Relationship coverage for the requested metrics. `readFollowerCounts` supplies counts read inside this request:
 * a count of zero, or a count equal to the followers already found, settles a metric without further reads.
 * Metrics without a usable count fall back to targeted subscription reads.
 */
export async function subscriptionCoverage(session: TableauSession, metricIds: string[], options: { snapshotId?: string; continueCoverage?: boolean; personalOnly?: boolean; refresh?: boolean; readFollowerCounts?: () => Promise<Record<string, number>> }, dependencies: SubscriptionDependencies): Promise<{ entries: Array<{ metricId: string; subscriptions: SubscriptionRecord[] | null; complete: boolean; canLoadMore: boolean; diagnostic?: { message: string } }>; coverage: { status: 'available' | 'partial' | 'unavailable'; canLoadMore: boolean } }> {
  // An explicit refresh treats these metrics as changed: retained evidence is dropped, older reads are fenced,
  // and unrelated metrics keep their coverage.
  if (options.refresh) invalidateSubscriptionCoverage(session, metricIds);
  const owner = getSessionContext(session), coordinates = JSON.stringify([session.serverUrl, session.siteId, session.userId]);
  const current = () => owner === getSessionContext(session) && coordinates === JSON.stringify([session.serverUrl, session.siteId, session.userId]);
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
  // Counts are read only after ownership is validated. They come from this request, so they are newer than
  // retained pages unless a mutation touched the metric while they were in flight.
  const epochOf = (id: string) => epochs.get(session)?.get(id) ?? 0;
  const countEpochs = new Map(metricIds.map(id => [id, epochOf(id)]));
  const counts = options.readFollowerCounts ? await options.readFollowerCounts() : {};
  if (!current()) throw new Error('The Tableau session changed while followers were loading.');
  const freshCount = (id: string) => countEpochs.get(id) === epochOf(id) && typeof counts[id] === 'number' ? counts[id] : undefined;
  const captured = view;
  let calls = 0, halted = false;
  const canSend = () => { if (!current()) throw new Error('The Tableau session changed while followers were loading.'); if (halted || calls >= SUBSCRIPTION_CALLS_PER_REQUEST) return false; calls++; return true; };
  async function page(target: TargetCoverage, metricId?: string): Promise<void> {
    if (target.pending) return target.pending;
    if (target.complete || target.terminal || target.pages >= 20 || target.scanned >= 2000 || !canSend()) return;
    const version = target.version;
    target.pending = (async () => {
      try {
        if (!dependencies.listSubscriptionPage) {
          if (!metricId) return;
          const records = await dependencies.listSubscriptions(session, metricId);
          if (version === target.version && current()) {
            target.records = records.slice(0, 2000); target.scanned = target.records.length; target.complete = records.length <= 2000; target.pages++;
            if (!target.complete) stopAtLimit(target);
          }
          return;
        }
        const result = await dependencies.listSubscriptionPage(session, { ...(metricId ? { metricId } : {}), ...(captured.scope === 'user' && !metricId ? { userId: session.userId } : {}), ...(target.token ? { pageToken: target.token } : {}) });
        if (version !== target.version || !current()) return;
        const remaining = Math.max(0, 2000 - target.scanned), scanned = result.subscriptions.slice(0, remaining);
        const overflow = result.subscriptions.length > remaining;
        target.pages++; target.scanned += scanned.length; target.error = undefined;
        const records = scanned.filter(record => metricId || (record.metricId && captured.metricIds.has(record.metricId)));
        // Site limits apply to scanned records, even though unrelated identities are not retained.
        target.records.push(...records);
        if (overflow) { target.token = undefined; stopAtLimit(target); return; }
        if (!result.nextPageToken) { target.complete = true; target.token = undefined; return; }
        if (target.seen.has(result.nextPageToken) || !result.subscriptions.length) { target.error = new Error('Tableau returned an invalid follower page token, so the list stopped.'); target.token = undefined; target.terminal = true; return; }
        target.seen.add(result.nextPageToken); target.token = result.nextPageToken;
        if (target.scanned >= 2000 || target.pages >= 20) stopAtLimit(target);
      } catch (error) {
        if (error instanceof TableauError && error.kind === 'auth') throw error;
        if (version === target.version) target.error = error;
      }
    })().finally(() => { target.pending = undefined; });
    return target.pending;
  }
  const positives = (metricId: string) => view!.invalidated.has(metricId) ? [] : view!.site.records.filter(record => record.metricId === metricId);
  const settled = new Set<string>();
  // The target each metric uses in this request; a concurrent mutation may drop it from the view meanwhile.
  const chosen = new Map<string, TargetCoverage>();
  const settle = (metricId: string, records: SubscriptionRecord[]) => {
    const previous = view!.targeted.get(metricId);
    if (previous) previous.version++; // reads still in flight cannot overwrite the newer evidence
    const target = { ...fresh(), records, complete: true, demanded: true };
    view!.targeted.set(metricId, target); chosen.set(metricId, target);
    settled.add(metricId);
  };
  const settleByCount = (metricId: string, target: TargetCoverage) => {
    const count = freshCount(metricId);
    if (count === undefined || target.complete) return false;
    const found = [...positives(metricId), ...target.records];
    if (identityCount(found) !== count) return false;
    settle(metricId, found);
    return true;
  };
  for (const metricId of metricIds) if (freshCount(metricId) === 0) settle(metricId, []);
  if (!view.discovered && metricIds.some(id => !settled.has(id))) {
    if (!view.discovery) view.discovery = page(view.site).finally(() => { view!.discovered = true; view!.discovery = undefined; });
    await view.discovery;
  }
  if (options.continueCoverage && dependencies.listSubscriptionPage) while (view.site.token && !view.site.complete && calls < SUBSCRIPTION_CALLS_PER_REQUEST && view.site.pages < 20) {
    const previous = view.site.pages; await page(view.site); if (view.site.error || previous === view.site.pages) break;
  }
  const qualified = (view.scope === 'site' && dependencies.siteNegativeCoverageQualified === true) || (view.scope === 'user' && options.personalOnly === true);
  const siteCovered = (metricId: string) => !settled.has(metricId) && qualified && view!.site.complete && view!.siteEligible.has(metricId) && !view!.invalidated.has(metricId);
  let round: Array<{ metricId: string; target: TargetCoverage }> = [];
  for (const metricId of metricIds) {
    if (settled.has(metricId) || siteCovered(metricId)) continue;
    let target = view.targeted.get(metricId);
    if (!target) { target = fresh(); view.targeted.set(metricId, target); }
    chosen.set(metricId, target);
    if (settleByCount(metricId, target)) continue;
    if (!target.complete && ((!target.demanded && !target.error) || target.pending || options.continueCoverage)) {
      target.demanded = true; round.push({ metricId, target });
    }
  }
  // Breadth first: every demanded metric gets its next page before any metric gets another, so a budget stop is fair.
  while (round.length && !halted && calls < SUBSCRIPTION_CALLS_PER_REQUEST) {
    const progressed = await mapWithConcurrency(round, SUBSCRIPTION_READ_CONCURRENCY, async ({ metricId, target }) => {
      const previous = target.pages;
      try { await page(target, metricId); } catch (error) { halted = true; throw error; }
      return previous !== target.pages && !target.error && !target.complete && Boolean(target.token);
    });
    round = round.filter(({ metricId, target }, index) => progressed[index] && view!.targeted.get(metricId) === target && !settleByCount(metricId, target));
  }
  const entries = [];
  for (const metricId of metricIds) {
    if (siteCovered(metricId)) {
      entries.push({ metricId, subscriptions: view.site.records.filter(record => record.metricId === metricId), complete: true, canLoadMore: false }); continue;
    }
    const target = chosen.get(metricId)!;
    const records = target.complete ? target.records : [...positives(metricId), ...target.records].slice(0, 2000);
    const hasEvidence = target.complete || records.length > 0;
    const canLoadMore = !target.complete && !target.terminal && target.pages < 20 && target.scanned < 2000;
    entries.push({ metricId, subscriptions: hasEvidence ? records : null, complete: target.complete, canLoadMore, ...(!target.complete ? { diagnostic: { message: target.error instanceof Error ? target.error.message : MORE_FOLLOWERS } } : {}) });
  }
  if (!current()) throw new Error('The Tableau session changed while followers were loading.');
  const complete = entries.every(entry => entry.complete);
  const canLoadMore = entries.some(entry => entry.canLoadMore);
  return { entries, coverage: { status: complete ? 'available' : entries.some(entry => entry.subscriptions) ? 'partial' : 'unavailable', canLoadMore } };
}
