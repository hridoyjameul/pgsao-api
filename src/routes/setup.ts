import type { FastifyInstance } from 'fastify';
import type { GatewayDeps } from '../app.js';

const LOOPBACK_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * GET /v1/setup/key — lets the dashboard fill in the gateway key by itself on
 * first load, instead of making a non-developer user open .env in a text
 * editor to find it. Deliberately unauthenticated (there's no key to send yet
 * on a fresh install) but loopback-only: even if HOST is ever changed to
 * 0.0.0.0, this endpoint still never answers a request from off this machine.
 */
export function registerSetupRoute(app: FastifyInstance, gateway: GatewayDeps): void {
  app.get('/v1/setup/key', async (request, reply) => {
    if (!LOOPBACK_IPS.has(request.ip)) {
      reply.code(403).send({ error: { type: 'permission_error', message: 'Only reachable from localhost' } });
      return;
    }
    return { apiKey: gateway.config.GATEWAY_API_KEY };
  });
}
