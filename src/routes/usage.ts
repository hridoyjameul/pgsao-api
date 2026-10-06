import type { FastifyInstance } from 'fastify';
import type { GatewayDeps } from '../app.js';

/** GET /v1/usage — request audit totals split by route and provider. */
export function registerUsageRoute(app: FastifyInstance, gateway: GatewayDeps): void {
  app.get('/v1/usage', { preHandler: gateway.requireApiKey }, async () => {
    return gateway.sessionManager.getUsageStats();
  });
}
