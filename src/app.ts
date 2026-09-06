import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config/config.js';
import type { ClaudeProvider } from './providers/types.js';
import { AgentSdkClaudeProvider } from './providers/claude.js';
import { SessionManager } from './sessions/session-manager.js';
import { CredentialMonitor } from './auth/credential-monitor.js';
import { ConcurrencyQueue } from './concurrency/queue.js';
import { createApiKeyPreHandler } from './auth/api-key.js';
import { createLoggerOptions } from './utils/logger.js';
import { registerHealthRoute } from './routes/health.js';
import { registerModelsRoute } from './routes/models.js';
import { registerSessionsRoutes } from './routes/sessions.js';
import { registerAnthropicCompatRoute } from './routes/anthropic-compat.js';
import { registerOpenAiCompatRoute } from './routes/openai-compat.js';
import { ApiError } from './errors/api-error.js';

export interface GatewayDeps {
  config: Config;
  claudeProvider: ClaudeProvider;
  sessionManager: SessionManager;
  credentialMonitor: CredentialMonitor;
  queue: ConcurrencyQueue;
  requireApiKey: ReturnType<typeof createApiKeyPreHandler>;
}

export interface BuildAppOptions {
  config: Config;
  /** Injectable for tests — see tests/support/fake-claude-provider.ts. Defaults to the real Agent SDK adapter. */
  claudeProvider?: ClaudeProvider;
  /** Override for tests, e.g. ':memory:'. Defaults to config.DATABASE_URL. */
  dbPath?: string;
}

export function buildApp(opts: BuildAppOptions): FastifyInstance {
  const { config } = opts;
  const app = Fastify({ logger: createLoggerOptions(config) });

  const claudeProvider = opts.claudeProvider ?? new AgentSdkClaudeProvider();
  const sessionManager = new SessionManager(opts.dbPath ?? config.DATABASE_URL);
  const credentialMonitor = new CredentialMonitor(claudeProvider, config.CREDENTIAL_CHECK_INTERVAL_MS);
  const queue = new ConcurrencyQueue({
    maxConcurrent: config.MAX_CONCURRENT_REQUESTS,
    maxQueueSize: config.QUEUE_MAX_SIZE,
    requestTimeoutMs: config.REQUEST_TIMEOUT_MS,
  });
  const requireApiKey = createApiKeyPreHandler(config.GATEWAY_API_KEY);

  const gateway: GatewayDeps = { config, claudeProvider, sessionManager, credentialMonitor, queue, requireApiKey };
  app.decorate('gateway', gateway);

  app.addHook('onClose', async () => {
    credentialMonitor.stop();
    sessionManager.close();
  });

  // Fallback for routes that don't own a route-specific error shape (health/models/sessions —
  // the two compat routes never let an error reach here, they render through their own
  // translator's error function inside their own try/catch).
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof ApiError) {
      if (err.retryAfterSeconds) reply.header('retry-after', String(err.retryAfterSeconds));
      reply.code(err.httpStatus).send({ error: { type: err.category, message: err.message } });
      return;
    }
    app.log.error(err);
    reply.code(500).send({ error: { type: 'internal_error', message: 'Internal server error' } });
  });

  registerHealthRoute(app, gateway);
  registerModelsRoute(app, gateway);
  registerSessionsRoutes(app, gateway);
  if (config.ENABLE_ANTHROPIC_COMPAT_ROUTE) registerAnthropicCompatRoute(app, gateway);
  if (config.ENABLE_OPENAI_COMPAT_ROUTE) registerOpenAiCompatRoute(app, gateway);

  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    gateway: GatewayDeps;
  }
}
