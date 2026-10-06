import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { GatewayDeps } from '../app.js';
import { ApiError } from '../errors/api-error.js';

const ServingBody = z.strictObject({ enabled: z.boolean() });

export function registerControlRoute(app: FastifyInstance, gateway: GatewayDeps): void {
  app.get('/v1/control/serving', { preHandler: gateway.requireApiKey }, async () => ({ enabled: gateway.servingGate.enabled }));
  app.post('/v1/control/serving', { preHandler: gateway.requireApiKey }, async (request) => {
    const parsed = ServingBody.safeParse(request.body);
    if (!parsed.success) throw new ApiError('invalid_request_error', 'Body must be exactly { enabled: boolean }');
    gateway.servingGate.setEnabled(parsed.data.enabled);
    return { enabled: gateway.servingGate.enabled };
  });
}
