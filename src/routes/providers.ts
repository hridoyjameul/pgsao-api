import type { FastifyInstance } from 'fastify';
import type { GatewayDeps } from '../app.js';

export function registerProvidersRoute(app: FastifyInstance, gateway: GatewayDeps): void {
  app.get('/v1/providers', { preHandler: gateway.requireApiKey }, async () => ({
    providers: await gateway.providerRegistry.listStatuses(),
  }));
}
