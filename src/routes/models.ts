import type { FastifyInstance } from 'fastify';
import type { GatewayDeps } from '../app.js';
import { listModelAliases } from '../config/models.js';

/** GET /v1/models — lists the model alias allow-list (PRD §6.1); not an open passthrough. */
export function registerModelsRoute(app: FastifyInstance, gateway: GatewayDeps): void {
  app.get('/v1/models', { preHandler: gateway.requireApiKey }, async () => {
    const aliases = listModelAliases();
    return {
      object: 'list',
      data: aliases.map((id) => ({ id, object: 'model', owned_by: 'pigsao-api' })),
    };
  });
}
