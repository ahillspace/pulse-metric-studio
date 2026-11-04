import Fastify, { LogController, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import fastifyStatic from '@fastify/static';
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
  TableauThrottleError,
  isAllowedAppOrigin,
  sanitizeProviderMessage,
  configureTableauTelemetry,
  runWithTableauTelemetry,
  safeTableauAppPath,
} from '@pulse-metric-studio/core';
import type { AuthorOpsFn } from '@pulse-metric-studio/core';
import { createDesktopRequestVerifier, DESKTOP_BODY_LIMIT, DESKTOP_PROTOCOL } from './desktop.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Clamp a provider-reported status to a valid HTTP error code. Non-error codes
 * (e.g. 0 for a network failure, or anything outside 400-599) map to 502,
 * since reaching the error handler means the request did fail upstream.
 */
function clampHttpErrorCode(status: number): number {
  return Number.isInteger(status) && status >= 400 && status < 600 ? status : 502;
}

export type FeatureHooks = {
  authorOps?: AuthorOpsFn;
  registerPulseRoutes?: (app: FastifyInstance) => void;
};

export function buildApp(hooks: FeatureHooks = {}, options: {
  desktopToken?: string;
  logStream?: { write(message: string): void };
} = {}) {
  const desktopToken = options.desktopToken;
  if (process.env.PULSE_METRIC_STUDIO_DESKTOP_IDENTIFIER === 'com.ahillspace.pulsemetricstudio' && !desktopToken) {
    throw new Error('Pulse desktop authentication is required.');
  }
  const verifyDesktopRequest = desktopToken ? createDesktopRequestVerifier(desktopToken) : null;
  const app = Fastify({
    bodyLimit: DESKTOP_BODY_LIMIT,
    logController: new LogController({ disableRequestLogging: true }),
    requestIdHeader: false,
    genReqId: () => crypto.randomUUID(),
    logger: {
      level: config.logLevel,
      ...(options.logStream ? { stream: options.logStream } : {}),
      redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers.set-cookie'],
      serializers: { req: (request) => ({ method: request.method, url: request.url?.split('?')[0] }) },
    },
  });

  // Tableau diagnostics are a default-level record even when routine server
  // verbosity is lowered. The core telemetry boundary projects safe fields.
  const diagnostics = app.log.child({}, { level: 'info' });
  configureTableauTelemetry((event) => diagnostics.info(event));
  app.addHook('onRequest', (request, _reply, done) => {
    runWithTableauTelemetry({
      reqId: request.id,
      appMethod: request.method,
      appPath: request.routeOptions.url ?? request.url,
      log: (event) => diagnostics.info(event),
    }, done);
  });
  app.addHook('onResponse', async (request, reply) => {
    const routePath = request.routeOptions.url;
    const requestPath = safeTableauAppPath(routePath ?? request.url);
    const successfulHealthCheck = request.method === 'GET' && reply.statusCode < 400
      && routePath !== undefined
      && ['/api/tableau/status', '/api/tableau/throttle', '/api/llm/status', '/api/pulse/status', '/api/desktop/ready'].includes(routePath);
    if (successfulHealthCheck || !requestPath.startsWith('/api/')) return;
    diagnostics.info({ event: 'app.request', reqId: request.id, method: request.method,
      path: requestPath, status: reply.statusCode, durationMs: Math.round(reply.elapsedTime) });
  });

  app.addHook('onRequest', async (request, reply) => {
    if (desktopToken) {
      if (request.url.startsWith('/api/desktop/ready?')) {
        if (!isAllowedCorsOrigin(request.headers.origin)) {
          await reply.code(403).send({ error: 'Cross-origin request is not allowed.' });
          return;
        }
        const challenge = new URL(request.url, 'http://localhost').searchParams.get('challenge') ?? '';
        const proof = request.headers['x-pulse-proof'];
        const expectedProof = crypto.createHmac('sha256', desktopToken).update(`ready-request:${challenge}`).digest('hex');
        if (/^[a-f0-9]{64}$/.test(challenge) && typeof proof === 'string' && proof.length === expectedProof.length
          && crypto.timingSafeEqual(Buffer.from(proof), Buffer.from(expectedProof))) return;
        await reply.code(401).send({ error: 'Desktop authentication required.' });
        return;
      }
      if (!verifyDesktopRequest!(request.method, request.raw.url ?? '', request.headers)) {
        await reply.code(401).send({ error: 'Desktop authentication required.' });
        return;
      }
    }
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
  if (desktopBootstrapToken && !desktopToken) {
    app.get('/api/desktop/bootstrap', async (_request, reply) => {
      reply.header('Cache-Control', 'no-store');
      return { token: desktopBootstrapToken };
    });
  }

  if (desktopToken) {
    app.get('/api/desktop/ready', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const challenge = (request.query as { challenge?: string }).challenge ?? '';
      return { ready: true, protocol: DESKTOP_PROTOCOL,
        proof: crypto.createHmac('sha256', desktopToken).update(`ready-response:${challenge}`).digest('hex') };
    });
  }

  app.setErrorHandler((error: Error & { statusCode?: number }, _req, reply) => {
    // Typed Tableau/VDS failures expose `.status`/`.kind`, not `.statusCode`,
    // so they would otherwise collapse into the generic 500 and swallow the
    // provider's real message. Map them explicitly and surface the detail.
    if (error instanceof TableauError) {
      const code = error.kind === 'auth' ? 401 : clampHttpErrorCode(error.status);
      const snippet = error.bodySnippet ? error.bodySnippet.slice(0, 500) : '';
      const message = sanitizeProviderMessage(snippet ? `${error.message} - ${snippet}` : error.message);
      app.log.warn({ status: error.status, kind: error.kind, code }, 'Tableau provider request failed');
      reply.code(code).send({ error: message,
        ...(typeof error.sent === 'boolean' ? { sent: error.sent } : {}),
        ...(error instanceof TableauThrottleError ? { throttle: error.throttle } : {}) });
      return;
    }
    // Any error carrying an explicit HTTP error status (4xx or 5xx) surfaces
    // its own message with that exact code (the response `error` stays a
    // string, matching what downstream API clients read).
    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 600) {
      app.log.warn({ statusCode: error.statusCode }, 'Request failed with explicit status');
      reply.code(error.statusCode).send({ error: sanitizeProviderMessage(error.message) });
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
    app.log.error({ name: error.name, message: sanitizeProviderMessage(error.message), reference }, 'Unhandled server error');
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

  // Core infrastructure: connection management + LLM provider routing.
  // Feature modules supply capability-specific brains (e.g. metric authoring).
  registerTableauRoutes(app);
  registerLlmRoutes(app, { authorOps: hooks.authorOps });
  hooks.registerPulseRoutes?.(app);

  // Packaged layouts vary by deploy script: files land either at web/dist or
  // directly under web. Accept whichever exists so static mounting never
  // silently skips, which otherwise surfaces as a JSON 404 on GET /.
  const webDist = ['../../web/dist', '../../web']
    .map((candidate) => path.resolve(here, candidate))
    .find((candidate) => fs.existsSync(candidate));
  if (!desktopToken && webDist && fs.existsSync(webDist)) {
    app.register(fastifyStatic, {
      root: webDist,
      setHeaders: (reply, pathname) => {
        if (pathname === '/' || pathname.endsWith('.html')) reply.header('Cache-Control', 'no-store');
      },
      wildcard: false,
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) {
        reply.code(404).send({ error: 'Not found' });
        return;
      }
      return reply.sendFile('index.html');
    });
  }

  return app;
}

const serverOrigin = `http://${config.host}:${config.port}`;

export function isAllowedCorsOrigin(origin: string | undefined): boolean {
  return isAllowedAppOrigin(origin, config.corsAllowedOrigins, serverOrigin);
}
