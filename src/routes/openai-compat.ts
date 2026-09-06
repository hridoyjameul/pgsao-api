import type { FastifyInstance, FastifyReply } from 'fastify';
import type { GatewayDeps } from '../app.js';
import { OpenAiChatCompletionsRequestSchema } from '../schemas/openai-messages.js';
import { openAiRequestToInternal, internalResponseToOpenAi, errorToOpenAiBody, toOpenAiChunks } from '../translator/openai.js';
import { ApiError } from '../errors/api-error.js';
import { generateRequestId } from '../utils/ids.js';
import { assertToolSchemasSupported } from '../utils/json-schema-to-zod.js';
import type { InternalClaudeRequest } from '../providers/types.js';

function sendOpenAiError(reply: FastifyReply, err: unknown): void {
  if (err instanceof ApiError) {
    reply.code(err.httpStatus);
    if (err.retryAfterSeconds) reply.header('retry-after', String(err.retryAfterSeconds));
    reply.send(errorToOpenAiBody(err.category, err.message, { param: err.param, code: err.code }));
    return;
  }
  reply.code(500).send({ error: { message: 'Internal server error', type: 'internal_error', param: null, code: null } });
}

/** POST /v1/chat/completions — OpenAI-compatible (PRD §7.A). Reuses the same InternalClaudeRequest pipeline the Anthropic route established. */
export function registerOpenAiCompatRoute(app: FastifyInstance, gateway: GatewayDeps): void {
  const { sessionManager, claudeProvider, queue, credentialMonitor, requireApiKey } = gateway;

  // Auth is checked INSIDE the handler's own try/catch (not a Fastify
  // preHandler) so a rejection renders through this route's own OpenAI
  // error shape — a preHandler's thrown error bypasses the handler entirely
  // and would otherwise fall through to Fastify's generic 500 response.
  app.post('/v1/chat/completions', async (request, reply) => {
    const requestId = generateRequestId();
    const startedAt = Date.now();
    let sessionIdForLog: string | undefined;

    try {
      await requireApiKey(request, reply);
      credentialMonitor.assertValid();

      const parsed = OpenAiChatCompletionsRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        const issue = parsed.error.issues[0]!;
        throw new ApiError('invalid_request_error', issue.message, { param: issue.path.join('.') || undefined });
      }
      const body = parsed.data;
      sessionIdForLog = body.session_id;

      const draft = openAiRequestToInternal(body);
      const { providerSessionId } = sessionManager.resolveSession(body.session_id);
      const internalRequest: InternalClaudeRequest = { ...draft, resumeSessionId: providerSessionId };

      // Validate tool schemas up front, before any SSE headers are sent —
      // the lazy conversion inside providers/claude.ts otherwise throws only
      // once claudeProvider.streamMessage() actually builds the tool
      // interception, by which point writeHead(200, ...) below has already
      // committed the response and an ApiError can no longer render as a
      // real error (see json-schema-to-zod.ts's assertToolSchemasSupported).
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
          for await (const chunk of toOpenAiChunks(tapSessionId())) {
            reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
          }
        });
        // Literal [DONE] sentinel (not JSON) — real OpenAI clients parse for this exact string (PRD §9).
        reply.raw.write('data: [DONE]\n\n');
        reply.raw.end();
        if (body.session_id && capturedSessionId) sessionManager.attachProviderSessionId(body.session_id, capturedSessionId);
        sessionManager.recordRequest({ id: requestId, sessionId: body.session_id, route: 'openai', status: 'ok', startedAt, completedAt: Date.now(), queueWaitMs });
        return;
      }

      const submittedAt = Date.now();
      let queueWaitMs = 0;
      const response = await queue.run(async () => {
        queueWaitMs = Date.now() - submittedAt;
        return claudeProvider.sendMessage(internalRequest);
      });

      if (body.session_id) sessionManager.attachProviderSessionId(body.session_id, response.sessionId);
      sessionManager.recordRequest({ id: requestId, sessionId: body.session_id, route: 'openai', status: 'ok', startedAt, completedAt: Date.now(), queueWaitMs });

      reply.send(internalResponseToOpenAi(response));
    } catch (err) {
      sessionManager.recordRequest({
        id: requestId,
        sessionId: sessionIdForLog,
        route: 'openai',
        status: 'error',
        startedAt,
        completedAt: Date.now(),
        errorType: err instanceof ApiError ? err.category : 'unknown',
      });
      if (!reply.raw.headersSent) {
        sendOpenAiError(reply, err);
      } else {
        reply.raw.end();
      }
    }
  });
}
