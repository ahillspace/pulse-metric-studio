import type { BuilderDraft } from '@pulse-metric-studio/shared';
import type { DraftContext } from '../../api/client';

export interface DraftSnapshot { key: string; draft: BuilderDraft; context?: DraftContext }
export interface DraftSaveState { key: string; name: string; status: 'pending' | 'saving' | 'saved' | 'error'; error?: string }
interface Entry { snapshot: DraftSnapshot; revision: number; timer?: ReturnType<typeof setTimeout>; running?: Promise<void>; savedRevision: number; error?: string }

/** One debounce and serialized writer per owning connection/site/datasource. */
export function createDraftSaveQueue(write: (snapshot: DraftSnapshot) => Promise<unknown>, notify: (state: DraftSaveState) => void) {
  const entries = new Map<string, Entry>();
  const report = (entry: Entry, status: DraftSaveState['status']) => notify({ key: entry.snapshot.key, name: entry.snapshot.draft.datasourceName, status, error: entry.error });
  async function flush(key: string): Promise<void> {
    const entry = entries.get(key);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    if (entry.running) {
      await entry.running;
      if (!entry.error && entry.savedRevision < entry.revision) await flush(key);
      return;
    }
    if (entry.savedRevision === entry.revision) return;
    const snapshot = entry.snapshot;
    const revision = entry.revision;
    entry.error = undefined;
    report(entry, 'saving');
    entry.running = (async () => {
      try {
        await write(snapshot);
        entry.savedRevision = revision;
        report(entry, revision === entry.revision ? 'saved' : 'pending');
      } catch (error) {
        entry.error = error instanceof Error ? error.message : String(error);
        report(entry, 'error');
      }
    })();
    await entry.running;
    entry.running = undefined;
    if (!entry.error && entry.savedRevision < entry.revision) await flush(key);
  }
  return {
    schedule(snapshot: DraftSnapshot) {
      const previous = entries.get(snapshot.key);
      if (previous?.timer) clearTimeout(previous.timer);
      const entry: Entry = previous ?? { snapshot, revision: 0, savedRevision: 0 };
      entry.snapshot = snapshot;
      entry.revision += 1;
      entry.error = undefined;
      entry.timer = setTimeout(() => void flush(snapshot.key), 600);
      entries.set(snapshot.key, entry);
      report(entry, 'pending');
    },
    flush,
    pending(key: string) {
      const entry = entries.get(key);
      return entry && entry.savedRevision < entry.revision ? entry.snapshot.draft : undefined;
    },
    async retry() { await Promise.all([...entries.keys()].map(flush)); },
  };
}
