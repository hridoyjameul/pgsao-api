import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { GatewayDeps } from '../app.js';
import { ApiError } from '../errors/api-error.js';
import { isProviderId } from '../auth/provider-keys.js';

const ServingBody = z.strictObject({ enabled: z.boolean() });

export function registerProvidersRoute(app: FastifyInstance, gateway: GatewayDeps): void {
  const pre = { preHandler: gateway.requireApiKey };

  app.get('/v1/providers', pre, async () => ({
    providers: (await gateway.providerRegistry.listStatuses()).map((status) => ({ ...status, serving: gateway.servingGate.isProviderEnabled(status.id) })),
  }));

  app.get<{ Params: { id: string } }>('/v1/providers/:id/key', pre, async (request, reply) => {
    if (!isProviderId(request.params.id)) return reply.code(404).send({ error: { type: 'not_found_error', message: 'Unknown provider' } });
    return { apiKey: gateway.providerKeys.get(request.params.id) };
  });
  app.post<{ Params: { id: string } }>('/v1/providers/:id/key/rotate', pre, async (request, reply) => {
    if (!isProviderId(request.params.id)) return reply.code(404).send({ error: { type: 'not_found_error', message: 'Unknown provider' } });
    return { apiKey: gateway.providerKeys.rotate(request.params.id) };
  });

  app.get<{ Params: { id: string } }>('/v1/providers/:id/serving', pre, async (request, reply) => {
    if (!isProviderId(request.params.id)) return reply.code(404).send({ error: { type: 'not_found_error', message: 'Unknown provider' } });
    return { enabled: gateway.servingGate.isProviderEnabled(request.params.id) };
  });
  app.post<{ Params: { id: string } }>('/v1/providers/:id/serving', pre, async (request, reply) => {
    if (!isProviderId(request.params.id)) return reply.code(404).send({ error: { type: 'not_found_error', message: 'Unknown provider' } });
    const parsed = ServingBody.safeParse(request.body);
    if (!parsed.success) throw new ApiError('invalid_request_error', 'Body must be exactly { enabled: boolean }');
    gateway.servingGate.setProviderEnabled(request.params.id, parsed.data.enabled);
    return { enabled: gateway.servingGate.isProviderEnabled(request.params.id) };
  });
}
