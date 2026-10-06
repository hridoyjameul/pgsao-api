import type { FastifyInstance } from 'fastify';
import type { GatewayDeps } from '../app.js';
import { ApiError } from '../errors/api-error.js';
import { isProviderId } from '../auth/provider-keys.js';

/** GET /v1/usage[?provider=id] — request audit totals split by route and provider. */
export function registerUsageRoute(app: FastifyInstance, gateway: GatewayDeps): void {
  app.get<{ Querystring: { provider?: string } }>('/v1/usage', { preHandler: gateway.requireApiKey }, async (request) => {
    const { provider } = request.query;
    if (provider !== undefined && !isProviderId(provider)) throw new ApiError('invalid_request_error', 'Unknown provider');
    return gateway.sessionManager.getUsageStats(provider);
  });
}
