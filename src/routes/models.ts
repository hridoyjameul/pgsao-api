import type { FastifyInstance } from 'fastify';
import type { GatewayDeps } from '../app.js';
import { listModelAliases } from '../config/models.js';

/** GET /v1/models — lists the model alias allow-list (PRD §6.1); not an open passthrough. */
export function registerModelsRoute(app: FastifyInstance, gateway: GatewayDeps, paths: readonly string[]): void {
  const handler = async () => {
    const aliases = listModelAliases();
    return {
      object: 'list',
      data: aliases.map((id) => ({ id, object: 'model', owned_by: 'pgsao-api' })),
    };
  };
  for (const path of paths) app.get(path, { preHandler: gateway.requireProviderKey('claude') }, handler);
}
