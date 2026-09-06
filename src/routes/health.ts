import type { FastifyInstance } from 'fastify';
import type { GatewayDeps } from '../app.js';
import { GATEWAY_VERSION } from '../utils/version.js';

/** GET /health — unauthenticated (PRD §12), for monitoring/orchestration tooling. */
export function registerHealthRoute(app: FastifyInstance, gateway: GatewayDeps): void {
  app.get('/health', async () => {
    const { credentialMonitor, queue, config } = gateway;
    return {
      status: 'ok',
      service: 'pgsao-api',
      version: GATEWAY_VERSION,
      claude_auth_status: credentialMonitor.status.ok ? 'ok' : 'error',
      active_requests: queue.stats.active,
      queued_requests: queue.stats.queued,
      routes: {
        openai_compatible: config.ENABLE_OPENAI_COMPAT_ROUTE ? 'enabled' : 'disabled',
        anthropic_compatible: config.ENABLE_ANTHROPIC_COMPAT_ROUTE ? 'enabled' : 'disabled',
      },
    };
  });
}
