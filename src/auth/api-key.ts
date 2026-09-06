import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from '../errors/api-error.js';

/**
 * Accepts EITHER `Authorization: Bearer <key>` OR `x-api-key: <key>` on BOTH
 * routes (PRD §6.4) — real OpenAI clients default to Bearer, real Anthropic
 * clients default to x-api-key. Rejects only if neither header carries the
 * valid key. `anthropic-version` is accepted and silently ignored elsewhere
 * (never validated here) — there is only one internal Claude version.
 */
export function createApiKeyPreHandler(gatewayApiKey: string) {
  return async function apiKeyPreHandler(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const authHeader = request.headers['authorization'];
    const bearerKey = typeof authHeader === 'string' && authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : undefined;
    const xApiKey = request.headers['x-api-key'];
    const providedKey = bearerKey ?? (typeof xApiKey === 'string' ? xApiKey : undefined);

    if (!providedKey || providedKey !== gatewayApiKey) {
      throw new ApiError('authentication_error', 'Missing or invalid API key — provide it via Authorization: Bearer <key> or x-api-key: <key>', {
        code: 'invalid_api_key',
      });
    }
  };
}
