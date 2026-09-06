import type { FastifyInstance } from 'fastify';
import type { GatewayDeps } from '../app.js';

/** GET /v1/usage — basic dashboard data split by route (PRD §22 P2.4/§28 Phase 4), from the `requests` audit log every call already writes to. */
export function registerUsageRoute(app: FastifyInstance, gateway: GatewayDeps): void {
  app.get('/v1/usage', { preHandler: gateway.requireApiKey }, async () => {
    return gateway.sessionManager.getUsageStats();
  });
}
