import type { FastifyInstance } from 'fastify';
import type { GatewayDeps } from '../app.js';

export function registerChatGptAuthRoutes(app: FastifyInstance, gateway: GatewayDeps): void {
  app.post<{ Body: { registrationId?: string } }>('/v1/providers/chatgpt/connect', { preHandler: gateway.requireApiKey }, async (request, reply) => {
    const body = request.body ?? {};
    if (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => key !== 'registrationId')
      || (body.registrationId !== undefined && typeof body.registrationId !== 'string')) {
      return reply.code(400).send({ error: { type: 'invalid_request_error', message: 'Invalid registration selection' } });
    }
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : gateway.config.PORT;
    try {
      const authorizationUrl = await gateway.chatGptOAuth.start(`http://127.0.0.1:${port}/auth/callback`, body.registrationId);
      return { authorizationUrl };
    } catch {
      return reply.code(400).send({ error: { type: 'invalid_request_error', message: 'Cannot start ChatGPT sign-in' } });
    }
  });

  app.get<{ Querystring: Record<string, string> }>('/auth/callback', { logLevel: 'silent' }, async (request, reply) => {
    const success = await gateway.chatGptOAuth.complete(request.query);
    return reply.code(303).header('location', `/dashboard?chatgpt=${success ? 'connected' : 'failed'}`).send();
  });
}
