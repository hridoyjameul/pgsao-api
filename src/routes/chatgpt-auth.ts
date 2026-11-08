import type { FastifyInstance } from 'fastify';
import type { GatewayDeps } from '../app.js';

// Only loopback names: anything else would turn the callback into an open redirect.
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\]):\d{1,5}$/;
const RETURN_TTL_MS = 600_000;

export function registerChatGptAuthRoutes(app: FastifyInstance, gateway: GatewayDeps): void {
  // OpenAI always returns to 127.0.0.1, but a dashboard opened at localhost keeps its key in
  // that origin's storage. Remember where each sign-in started so the user lands back there.
  const returnHosts = new Map<string, { host: string; expiresAt: number }>();

  app.post('/v1/providers/chatgpt/disconnect', { preHandler: gateway.requireApiKey }, async () => gateway.chatGptConnection.disconnect());
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
      const state = new URL(authorizationUrl).searchParams.get('state');
      const host = request.headers.host;
      for (const [key, value] of returnHosts) if (value.expiresAt < Date.now()) returnHosts.delete(key);
      if (state && host && LOOPBACK_HOST.test(host)) returnHosts.set(state, { host, expiresAt: Date.now() + RETURN_TTL_MS });
      return { authorizationUrl };
    } catch {
      return reply.code(400).send({ error: { type: 'invalid_request_error', message: 'Cannot start ChatGPT sign-in' } });
    }
  });

  app.get<{ Querystring: Record<string, string> }>('/auth/callback', { logLevel: 'silent' }, async (request, reply) => {
    const state = typeof request.query.state === 'string' ? request.query.state : '';
    const origin = returnHosts.get(state);
    returnHosts.delete(state);
    const success = await gateway.chatGptOAuth.complete(request.query);
    const base = origin && origin.expiresAt >= Date.now() && origin.host !== request.headers.host ? `http://${origin.host}` : '';
    return reply.code(303).header('location', `${base}/dashboard?chatgpt=${success ? 'connected' : 'failed'}`).send();
  });
}
