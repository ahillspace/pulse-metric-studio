import type { FastifyInstance } from 'fastify';
import { getDb, getSession, getSessionContext, getStoredConnection } from '@pulse-metric-studio/core';

interface DraftContext {
  connectionId: string;
  serverUrl: string;
  siteId: string;
}

export function registerDraftRoutes(app: FastifyInstance): void {
  const currentContext = (): DraftContext => {
    const session = getSession();
    const context = session && getSessionContext(session);
    if (!context) throw app.httpErrors.unauthorized('Connect to Tableau to open a draft.');
    return { connectionId: context.connectionId, serverUrl: context.serverUrl, siteId: context.siteId };
  };

  const parseContext = (value: unknown): DraftContext => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw app.httpErrors.badRequest('Draft connection context is required.');
    }
    const candidate = value as Partial<DraftContext>;
    if (![candidate.connectionId, candidate.serverUrl, candidate.siteId].every((part) => typeof part === 'string' && part.trim())) {
      throw app.httpErrors.badRequest('Draft connection context is incomplete.');
    }
    return { connectionId: candidate.connectionId!, serverUrl: candidate.serverUrl!, siteId: candidate.siteId! };
  };

  const readContext = (query: unknown): DraftContext => {
    const current = currentContext();
    const values = query as Partial<DraftContext>;
    if (!Object.keys(values).some((key) => ['connectionId', 'serverUrl', 'siteId'].includes(key))) return current;
    const requested = parseContext(values);
    if (requested.connectionId !== current.connectionId || requested.serverUrl !== current.serverUrl || requested.siteId !== current.siteId) {
      throw app.httpErrors.conflict('The active Tableau connection changed. Reopen the datasource to load its draft.');
    }
    return current;
  };

  const key = (context: DraftContext, datasourceLuid: string) => [context.connectionId, context.serverUrl, context.siteId, datasourceLuid];

  app.get('/api/drafts/:datasourceLuid', async (req, reply) => {
    const { datasourceLuid } = req.params as { datasourceLuid: string };
    const context = readContext(req.query);
    const row = getDb().prepare(
      'SELECT state_json, updated_at FROM pulse_drafts WHERE connection_id = ? AND server_url = ? AND site_id = ? AND datasource_luid = ?',
    ).get(...key(context, datasourceLuid)) as { state_json: string; updated_at: number } | undefined;
    if (!row) return reply.code(404).send({ error: 'no draft' });
    return { draft: JSON.parse(row.state_json), updatedAt: row.updated_at };
  });

  app.put('/api/drafts/:datasourceLuid', async (req) => {
    const { datasourceLuid } = req.params as { datasourceLuid: string };
    const body = req.body as { draft?: unknown; context?: unknown };
    if (!body?.draft || typeof body.draft !== 'object' || Array.isArray(body.draft)) {
      throw app.httpErrors.badRequest('draft object required');
    }
    const draft = body.draft as { datasourceLuid?: unknown };
    if (draft.datasourceLuid !== undefined && draft.datasourceLuid !== datasourceLuid) {
      throw app.httpErrors.badRequest('Draft datasource does not match its save destination.');
    }
    const context = body.context === undefined ? currentContext() : parseContext(body.context);
    // A queued save keeps its original owner even after the user switches or disconnects.
    const connection = getStoredConnection(context.connectionId);
    if (!connection || connection.serverUrl !== context.serverUrl) {
      throw app.httpErrors.conflict('The draft connection was removed or changed. Your edits have not been saved.');
    }
    getDb().prepare(
      `INSERT INTO pulse_drafts (connection_id, server_url, site_id, datasource_luid, state_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(connection_id, server_url, site_id, datasource_luid)
       DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`,
    ).run(...key(context, datasourceLuid), JSON.stringify(body.draft), Date.now());
    return { ok: true };
  });

  app.delete('/api/drafts/:datasourceLuid', async (req) => {
    const { datasourceLuid } = req.params as { datasourceLuid: string };
    const context = readContext(req.query);
    getDb().prepare(
      'DELETE FROM pulse_drafts WHERE connection_id = ? AND server_url = ? AND site_id = ? AND datasource_luid = ?',
    ).run(...key(context, datasourceLuid));
    return { ok: true };
  });
}
