import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { once } from 'node:events';
import type { ServerResponse } from 'node:http';
import type { GatewayDeps } from '../app.js';
import { ApiError } from '../errors/api-error.js';
import { generateRequestId } from '../utils/ids.js';
import { errorToOpenAiBody } from '../translator/openai.js';
import { errorToAnthropicBody } from '../translator/anthropic.js';
import { isValidKimiKey } from '../kimi/connection.js';
import { KIMI_MODELS, type KimiPath } from '../kimi/upstream.js';

type Shape = 'openai' | 'anthropic';

function sendError(reply: FastifyReply, error: unknown, shape: Shape): void {
  const apiError = error instanceof ApiError ? error : new ApiError('provider_error', 'Internal server error');
  if (apiError.retryAfterSeconds) reply.header('retry-after', String(apiError.retryAfterSeconds));
  reply.code(apiError.httpStatus).send(shape === 'openai' ? errorToOpenAiBody(apiError.category, apiError.message) : errorToAnthropicBody(apiError.category, apiError.message));
}

async function pipeBody(upstream: Response, reply: ServerResponse): Promise<void> {
  if (!upstream.body) throw new ApiError('provider_error', 'Empty Kimi response');
  const contentType = upstream.headers.get('content-type') ?? 'application/json';
  reply.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-cache' });
  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!reply.write(value)) await once(reply, 'drain');
    }
  } finally { reader.releaseLock(); }
}

function registerProxy(app: FastifyInstance, gateway: GatewayDeps, url: string, upstreamPath: KimiPath, shape: Shape): void {
  app.post(url, async (request: FastifyRequest, reply: FastifyReply) => {
    const id = generateRequestId();
    const startedAt = Date.now();
    let queueWaitMs: number | undefined;
    try {
      await gateway.requireProviderKey('kimi')(request, reply);
      gateway.servingGate.assertEnabled('kimi');
      const body = request.body as Record<string, unknown> | null;
      if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.model !== 'string' || !body.model) {
        throw new ApiError('invalid_request_error', 'model is required', { param: 'model' });
      }
      const submittedAt = Date.now();
      await gateway.kimiQueue.run(async () => {
        queueWaitMs = Date.now() - submittedAt;
        const upstream = await gateway.kimiUpstream.request(upstreamPath, 'POST', JSON.stringify(body));
        await pipeBody(upstream, reply.raw);
      });
      reply.raw.end();
      gateway.sessionManager.recordRequest({ id, provider: 'kimi', route: shape, status: 'ok', startedAt, completedAt: Date.now(), queueWaitMs });
    } catch (error) {
      gateway.sessionManager.recordRequest({ id, provider: 'kimi', route: shape, status: 'error', startedAt, completedAt: Date.now(), queueWaitMs, errorType: error instanceof ApiError ? error.category : 'unknown' });
      if (!reply.raw.headersSent) sendError(reply, error, shape);
      else reply.raw.end();
    }
  });
}

export function registerKimiRoutes(app: FastifyInstance, gateway: GatewayDeps): void {
  registerProxy(app, gateway, '/kimi/v1/chat/completions', '/v1/chat/completions', 'openai');
  registerProxy(app, gateway, '/kimi/v1/messages', '/v1/messages', 'anthropic');
  app.get('/kimi/v1/models', { preHandler: gateway.requireProviderKey('kimi') }, () => ({
    object: 'list',
    data: KIMI_MODELS.map((id) => ({ id, object: 'model', owned_by: 'kimi' })),
  }));

  app.post<{ Body: { apiKey?: unknown } }>('/v1/providers/kimi/credentials', { preHandler: gateway.requireApiKey }, async (request, reply) => {
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => key !== 'apiKey') || !isValidKimiKey(body.apiKey)) {
      return reply.code(400).send({ error: { type: 'invalid_request_error', message: 'Enter a valid Kimi membership key' } });
    }
    try {
      await gateway.kimiUpstream.request('/v1/models', 'GET', undefined, { key: body.apiKey });
    } catch (error) {
      // 404/405 only mean the models listing is not offered; only a real rejection or outage blocks saving.
      const unverifiable = error instanceof ApiError && error.category === 'invalid_request_error' && (error.code === '404' || error.code === '405');
      if (!unverifiable) {
        const rejected = error instanceof ApiError && error.category === 'credential_error';
        return reply.code(rejected ? 400 : 502).send({ error: { type: rejected ? 'invalid_request_error' : 'provider_error', message: rejected ? 'Kimi rejected this key' : 'Could not reach Kimi to verify the key' } });
      }
    }
    await gateway.kimiConnection.saveKey(body.apiKey);
    return { connected: true };
  });

  app.delete('/v1/providers/kimi/credentials', { preHandler: gateway.requireApiKey }, async () => {
    await gateway.kimiConnection.removeKey();
    return { connected: false };
  });
}
