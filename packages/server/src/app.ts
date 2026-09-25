import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  config,
  getDb,
  registerTableauRoutes,
  registerLlmRoutes,
  LlmProviderError,
  TableauError,
  isAllowedAppOrigin,
} from '@pulse-metric-studio/core';
import type { AuthorOpsFn } from '@pulse-metric-studio/core';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Clamp a provider-reported status to a valid HTTP error code. Non-error codes
 * (e.g. 0 for a network failure, or anything outside 400-599) map to 502,
 * since reaching the error handler means the request did fail upstream.
 */
function clampHttpErrorCode(status: number): number {
  return Number.isInteger(status) && status >= 400 && status < 600 ? status : 502;
}

export type PulseHooks = {
  authorOps?: AuthorOpsFn;
  registerPulseRoutes?: (app: FastifyInstance) => void;
};

export function buildApp(hooks: PulseHooks = {}) {
  const app = Fastify({
    logger: {
      level: config.logLevel,
    },
  });

  app.addHook('onRequest', async (request, reply) => {
    if (!isAllowedCorsOrigin(request.headers.origin)) {
      await reply.code(403).send({ message: 'Cross-origin request is not allowed.' });
    }
  });

  app.register(cors, {
    origin(origin, callback) {
      callback(null, isAllowedCorsOrigin(origin));
    },
  });
  app.register(sensible);

  const desktopBootstrapToken = process.env.PULSE_METRIC_STUDIO_DESKTOP_BOOTSTRAP_TOKEN?.trim();
  if (desktopBootstrapToken) {
    app.get('/api/desktop/bootstrap', async (_request, reply) => {
      reply.header('Cache-Control', 'no-store');
      return { token: desktopBootstrapToken };
    });
  }

  app.setErrorHandler((error: Error & { statusCode?: number }, _req, reply) => {
    // Typed Tableau/VDS failures expose `.status`/`.kind`, not `.statusCode`,
    // so they would otherwise collapse into the generic 500 and swallow the
    // provider's real message. Map them explicitly and surface the detail.
    if (error instanceof TableauError) {
      const code = error.kind === 'auth' ? 401 : clampHttpErrorCode(error.status);
      const snippet = error.bodySnippet ? error.bodySnippet.slice(0, 500) : '';
      const message = snippet ? `${error.message} - ${snippet}` : error.message;
      app.log.warn({ status: error.status, kind: error.kind, code }, 'Tableau provider request failed');
      reply.code(code).send({ error: message });
      return;
    }
    // Any error carrying an explicit HTTP error status (4xx or 5xx) surfaces
    // its own message with that exact code (the response `error` stays a
    // string, matching what downstream API clients read).
    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 600) {
      app.log.warn({ statusCode: error.statusCode }, 'Request failed with explicit status');
      reply.code(error.statusCode).send({ error: error.message });
      return;
    }
    if (error instanceof LlmProviderError) {
      app.log.warn({ code: error.code, provider: error.provider, model: error.model, reference: error.reference }, 'LLM provider request failed');
      reply.code(500).send({
        message: error.message,
        error: {
          code: error.code,
          message: error.message,
          provider: error.provider,
          model: error.model,
          retryable: error.retryable,
          reference: error.reference,
        },
      });
      return;
    }
    const reference = `err_${crypto.randomUUID()}`;
    app.log.error({ err: error, reference }, 'Unhandled server error');
    reply.code(500).send({
      message: 'Internal server error.',
      error: {
        code: 'internal_error',
        message: 'Internal server error.',
        provider: null,
        model: null,
        retryable: false,
        reference,
      },
    });
  });

  // Initialize database eagerly so first request is fast
  getDb();

  // Connection management, provider routing, and Pulse metric authoring.
  registerTableauRoutes(app);
  registerLlmRoutes(app, { authorOps: hooks.authorOps });
  hooks.registerPulseRoutes?.(app);

  // Packaged layouts vary by deploy script: files land either at web/dist or
  // directly under web. Accept whichever exists so static mounting never
  // silently skips, which otherwise surfaces as a JSON 404 on GET /.
  const webDist = ['../../web/dist', '../../web']
    .map((candidate) => path.resolve(here, candidate))
    .find((candidate) => fs.existsSync(candidate));
  if (webDist && fs.existsSync(webDist)) {
    app.register(import('@fastify/static'), {
      root: webDist,
      setHeaders: (reply, pathname) => {
        if (pathname === '/' || pathname.endsWith('.html')) reply.header('Cache-Control', 'no-store');
      },
      wildcard: false,
    }).then(() => {
      app.setNotFoundHandler((req, reply) => {
        if (req.url.startsWith('/api/')) {
          reply.code(404).send({ error: 'Not found' });
          return;
        }
        return reply.sendFile('index.html');
      });
    });
  }

  return app;
}

const serverOrigin = `http://${config.host}:${config.port}`;

export function isAllowedCorsOrigin(origin: string | undefined): boolean {
  return isAllowedAppOrigin(origin, config.corsAllowedOrigins, serverOrigin);
}
