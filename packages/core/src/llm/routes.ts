import type { FastifyInstance, FastifyRequest } from 'fastify';
import '@fastify/sensible';
import {
  LlmProfileWriteSchema,
  type LlmProtocol,
  type LlmModelCatalogResponse,
  type LlmProfilePublic,
  type LlmProfileWrite,
  type LlmProviderStatus,
  type LlmStatusResponse,
} from '@pulse-metric-studio/shared';
import type { LlmProvider, LlmProviderHealth } from './types.js';
import { getLlmRegistry, LlmModelCatalogError } from './registry.js';

export type AuthorOpsFn = (
  provider: LlmProvider,
  input: { catalog: any; chat: unknown[]; userMessage: string; selection: unknown },
) => Promise<unknown>;

export interface LlmProviderService {
  status(): Promise<LlmStatusResponse>;
  listProfiles(): Promise<LlmProfilePublic[]>;
  listModels(profileId: string): Promise<LlmModelCatalogResponse>;
  listSetupModels(protocol?: LlmProtocol, command?: string): Promise<LlmModelCatalogResponse>;
  setupStatus(protocol: LlmProtocol, command?: string): Promise<LlmProviderHealth>;
  close?(): Promise<void>;
  saveProfile(input: LlmProfileWrite): Promise<LlmProfilePublic>;
  deleteProfile(id: string): Promise<void>;
  setActive(id: string): Promise<string>;
  testProfile(id: string): Promise<LlmProviderStatus>;
  pick(preference?: string): Promise<LlmProvider>;
}

export function registerLlmRoutes(
  app: FastifyInstance,
  options: { authorOps?: AuthorOpsFn; service?: LlmProviderService } = {},
): void {
  const service = options.service ?? getLlmRegistry();
  app.addHook('preClose', async () => { await service.close?.(); });

  app.get('/api/llm/status', async () => service.status());
  app.get('/api/llm/profiles', async () => ({ profiles: await service.listProfiles() }));
  app.get('/api/llm/setup/:protocol/models', async (request) => {
    const protocol = setupProtocol(request);
    const { command } = request.query as { command?: unknown };
    if (command !== undefined && (typeof command !== 'string' || command.length > 1000 || /[\r\n\0]/.test(command))) throw app.httpErrors.badRequest('Invalid CLI command.');
    return service.listSetupModels(protocol, command as string | undefined);
  });

  app.get('/api/llm/setup/:protocol/status', async (request) => {
    const protocol = setupProtocol(request);
    const { command } = request.query as { command?: unknown };
    if (command !== undefined && (typeof command !== 'string' || command.length > 1000 || /[\r\n\0]/.test(command))) throw app.httpErrors.badRequest('Invalid CLI command.');
    return service.setupStatus(protocol, command as string | undefined);
  });

  app.get('/api/llm/profiles/:id/models', async (request) => {
    const id = String((request.params as { id?: string }).id ?? '');
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id)) throw app.httpErrors.badRequest('Invalid provider profile id.');
    return service.listModels(id);
  });

  app.put('/api/llm/profiles/:id', async (request) => {
    const id = String((request.params as { id?: string }).id ?? '');
    const body = { ...(request.body as Record<string, unknown> ?? {}), id };
    const parsed = LlmProfileWriteSchema.safeParse(body);
    if (!parsed.success) throw app.httpErrors.badRequest(validationMessage(parsed.error.issues));
    return service.saveProfile(parsed.data);
  });

  app.delete('/api/llm/profiles/:id', async (request) => {
    const id = String((request.params as { id?: string }).id ?? '');
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id)) throw app.httpErrors.badRequest('Invalid provider profile id.');
    await service.deleteProfile(id);
    return { ok: true };
  });

  app.post('/api/llm/profiles/:id/test', async (request) => {
    const id = String((request.params as { id?: string }).id ?? '');
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id)) throw app.httpErrors.badRequest('Invalid provider profile id.');
    return service.testProfile(id);
  });

  app.post('/api/llm/provider', async (request: FastifyRequest) => {
    const provider = typeof (request.body as { provider?: unknown } | null)?.provider === 'string'
      ? String((request.body as { provider: string }).provider)
      : '';
    if (!provider) throw app.httpErrors.badRequest('provider is required.');
    if (provider === 'auto') throw app.httpErrors.badRequest('Automatic provider selection is no longer supported. Select a provider profile.');
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(provider)) throw app.httpErrors.badRequest('Invalid provider profile id.');
    return { ok: true, active: await service.setActive(provider) };
  });

  if (options.authorOps) {
    app.post('/api/llm/author', async (request: FastifyRequest) => {
      const input = (request.body ?? {}) as {
        catalog?: { datasourceLuid?: string };
        userMessage?: string;
        chat?: unknown[];
        selection?: unknown;
      };
      if (!input.catalog?.datasourceLuid) throw app.httpErrors.badRequest('catalog with datasourceLuid is required.');
      if (!input.userMessage?.trim()) throw app.httpErrors.badRequest('userMessage is required.');
      return options.authorOps!(await service.pick(), {
        catalog: input.catalog,
        chat: Array.isArray(input.chat) ? input.chat.slice(-12) : [],
        userMessage: input.userMessage.trim().slice(0, 8000),
        selection: input.selection,
      });
    });
  }
}

function setupProtocol(request: FastifyRequest): LlmProtocol {
  const value = (request.params as { protocol: string }).protocol;
  if (value === 'opencode' || value === 'codex-cli' || value === 'claude-code') return value;
  throw new LlmModelCatalogError('Setup checks require a local CLI protocol.');
}

function validationMessage(issues: Array<{ path: PropertyKey[]; message: string }>): string {
  return issues.slice(0, 8).map((issue) => `${issue.path.join('.') || 'profile'}: ${issue.message}`).join('; ');
}
