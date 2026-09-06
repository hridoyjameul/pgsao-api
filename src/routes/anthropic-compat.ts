import type { FastifyInstance, FastifyReply } from 'fastify';
import type { GatewayDeps } from '../app.js';
import { AnthropicMessagesRequestSchema } from '../schemas/anthropic-messages.js';
import { anthropicRequestToInternal, internalResponseToAnthropic, errorToAnthropicBody, toAnthropicSSE } from '../translator/anthropic.js';
import { ApiError } from '../errors/api-error.js';
import { generateRequestId } from '../utils/ids.js';
import { assertToolSchemasSupported } from '../utils/json-schema-to-zod.js';
import type { InternalClaudeRequest } from '../providers/types.js';

function sendAnthropicError(reply: FastifyReply, err: unknown): void {
  if (err instanceof ApiError) {
    reply.code(err.httpStatus);
    if (err.retryAfterSeconds) reply.header('retry-after', String(err.retryAfterSeconds));
    reply.send(errorToAnthropicBody(err.category, err.message));
    return;
  }
  reply.code(500).send({ type: 'error', error: { type: 'internal_error', message: 'Internal server error' } });
}

/** POST /v1/messages — Anthropic-compatible (PRD §7.B). Built first per the Anthropic-first build order (lower impedance to the Claude Adapter's native shape). */
export function registerAnthropicCompatRoute(app: FastifyInstance, gateway: GatewayDeps): void {
  const { sessionManager, claudeProvider, queue, credentialMonitor, requireApiKey } = gateway;

  // Auth is checked INSIDE the handler's own try/catch (not a Fastify
  // preHandler) so a rejection renders through this route's own Anthropic
  // error shape — a preHandler's thrown error bypasses the handler entirely
  // and would otherwise fall through to Fastify's generic 500 response.
  app.post('/v1/messages', async (request, reply) => {
    const requestId = generateRequestId();
    const startedAt = Date.now();
    let sessionIdForLog: string | undefined;

    try {
      await requireApiKey(request, reply);
      credentialMonitor.assertValid();

      const parsed = AnthropicMessagesRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        const issue = parsed.error.issues[0]!;
        throw new ApiError('invalid_request_error', issue.message, { param: issue.path.join('.') || undefined });
      }
      const body = parsed.data;
      sessionIdForLog = body.session_id;

      const draft = anthropicRequestToInternal(body);
      const { providerSessionId } = sessionManager.resolveSession(body.session_id);
      const internalRequest: InternalClaudeRequest = { ...draft, resumeSessionId: providerSessionId };

      // Validate tool schemas up front, before any SSE headers are sent —
      // see routes/openai-compat.ts's identical guard for why.
      if (internalRequest.tools?.length) assertToolSchemasSupported(internalRequest.tools);

      if (body.stream) {
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        let capturedSessionId: string | undefined;
        async function* tapSessionId() {
          for await (const event of claudeProvider.streamMessage(internalRequest)) {
            if (event.type === 'start') capturedSessionId = event.sessionId;
            yield event;
          }
        }
        const submittedAt = Date.now();
        let queueWaitMs = 0;
        await queue.run(async () => {
          queueWaitMs = Date.now() - submittedAt;
          for await (const frame of toAnthropicSSE(tapSessionId())) {
            reply.raw.write(`event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`);
          }
        });
        reply.raw.end();
        if (body.session_id && capturedSessionId) sessionManager.attachProviderSessionId(body.session_id, capturedSessionId);
        sessionManager.recordRequest({ id: requestId, sessionId: body.session_id, route: 'anthropic', status: 'ok', startedAt, completedAt: Date.now(), queueWaitMs });
        return;
      }

      const submittedAt = Date.now();
      let queueWaitMs = 0;
      const response = await queue.run(async () => {
        queueWaitMs = Date.now() - submittedAt;
        return claudeProvider.sendMessage(internalRequest);
      });

      if (body.session_id) sessionManager.attachProviderSessionId(body.session_id, response.sessionId);
      sessionManager.recordRequest({ id: requestId, sessionId: body.session_id, route: 'anthropic', status: 'ok', startedAt, completedAt: Date.now(), queueWaitMs });

      reply.send(internalResponseToAnthropic(response));
    } catch (err) {
      sessionManager.recordRequest({
        id: requestId,
        sessionId: sessionIdForLog,
        route: 'anthropic',
        status: 'error',
        startedAt,
        completedAt: Date.now(),
        errorType: err instanceof ApiError ? err.category : 'unknown',
      });
      if (!reply.raw.headersSent) {
        sendAnthropicError(reply, err);
      } else {
        reply.raw.end();
      }
    }
  });
}
