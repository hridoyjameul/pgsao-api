import type { FastifyInstance } from 'fastify';
import type { GatewayDeps } from '../app.js';
import { ApiError } from '../errors/api-error.js';

/** POST/GET/DELETE /v1/sessions — explicit lifecycle management for the session_id extension (PRD §6.1/§7.C). Not a mandatory precondition: an unseen session_id passed directly to either compat route is auto-created (session-manager.ts). */
export function registerSessionsRoutes(app: FastifyInstance, gateway: GatewayDeps): void {
  const { sessionManager, requireApiKey } = gateway;

  app.post('/v1/sessions', { preHandler: requireApiKey }, async (_request, reply) => {
    const session = sessionManager.createSession();
    reply.code(201);
    return { id: session.id, created_at: session.createdAt };
  });

  app.get('/v1/sessions/:id', { preHandler: requireApiKey }, async (request) => {
    const { id } = request.params as { id: string };
    const session = sessionManager.getSession(id);
    if (!session) throw new ApiError('invalid_request_error', `No session found with id "${id}"`, { param: 'id' });
    return { id: session.id, provider_session_id: session.providerSessionId, created_at: session.createdAt, updated_at: session.updatedAt };
  });

  app.delete('/v1/sessions/:id', { preHandler: requireApiKey }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const deleted = sessionManager.deleteSession(id);
    if (!deleted) throw new ApiError('invalid_request_error', `No session found with id "${id}"`, { param: 'id' });
    reply.code(204);
    return null;
  });
}
