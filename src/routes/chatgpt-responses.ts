import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { GatewayDeps } from '../app.js';
import { ApiError } from '../errors/api-error.js';
import { generateRequestId } from '../utils/ids.js';
import { ChatGptResponsesRequestSchema, forwardChatGptSse } from '../chatgpt/responses.js';
import { errorToOpenAiBody } from '../translator/openai.js';

function sendError(reply: FastifyReply, error: unknown): void {
  if (error instanceof ApiError) {
    if (error.retryAfterSeconds) reply.header('retry-after', String(error.retryAfterSeconds));
    reply.code(error.httpStatus).send(errorToOpenAiBody(error.category, error.message));
  } else reply.code(500).send(errorToOpenAiBody('provider_error', 'Internal server error'));
}

export function registerChatGptResponsesRoute(app: FastifyInstance, gateway: GatewayDeps): void {
  app.post('/chatgpt/v1/responses', async (request: FastifyRequest, reply: FastifyReply) => {
    const id = generateRequestId();
    const startedAt = Date.now();
    let queueWaitMs: number | undefined;
    try {
      await gateway.requireProviderKey('chatgpt')(request, reply);
      gateway.servingGate.assertEnabled('chatgpt');
      const parsed = ChatGptResponsesRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        const issue = parsed.error.issues[0]!;
        throw new ApiError('invalid_request_error', issue.message, { param: issue.path.join('.') || undefined });
      }
      const submittedAt = Date.now();
      await gateway.chatGptQueue.run(async () => {
        queueWaitMs = Date.now() - submittedAt;
        const upstream = await gateway.chatGptUpstream.request('/responses', 'POST', JSON.stringify(parsed.data));
        await forwardChatGptSse(upstream, reply.raw);
      });
      reply.raw.end();
      gateway.sessionManager.recordRequest({ id, provider: 'chatgpt', route: 'responses', status: 'ok', startedAt, completedAt: Date.now(), queueWaitMs });
    } catch (error) {
      gateway.sessionManager.recordRequest({ id, provider: 'chatgpt', route: 'responses', status: 'error', startedAt, completedAt: Date.now(), queueWaitMs, errorType: error instanceof ApiError ? error.category : 'unknown' });
      if (!reply.raw.headersSent) sendError(reply, error);
      else reply.raw.end();
    }
  });
}
