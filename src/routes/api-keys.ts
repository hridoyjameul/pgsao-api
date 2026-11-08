import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { GatewayDeps } from '../app.js';
import { isProviderId, type ProfilePatch } from '../auth/provider-keys.js';
import type { ProviderId } from '../providers/registry.js';

const NAME = z.string().trim().min(1).max(64).regex(/^[^\x00-\x1f\x7f]+$/);
const MODEL = z.string().regex(/^[A-Za-z0-9._:/@\[\]-]{1,128}$/, 'Model IDs use letters, digits and . _ : / @ [ ] -');
const SETTING = z.string().min(1).max(128);

const CreateBody = z.strictObject({ name: NAME.optional(), accountId: SETTING.optional(), model: MODEL.optional(), effort: SETTING.optional() });
const PatchBody = z.strictObject({ name: NAME.optional(), accountId: SETTING.nullable().optional(), model: MODEL.nullable().optional(), effort: SETTING.nullable().optional() });

function fail(reply: FastifyReply, status: number, message: string) {
  return reply.code(status).send({ error: { type: status === 404 ? 'not_found_error' : 'invalid_request_error', message } });
}

/**
 * Multiple gateway API keys per provider. Each key can pin an account, a
 * model and a reasoning effort, so different apps can use one provider in
 * different ways without changing their own requests.
 */
export function registerApiKeyRoutes(app: FastifyInstance, gateway: GatewayDeps): void {
  const pre = { preHandler: gateway.requireApiKey };

  /** Rejects settings the provider cannot honor, so a saved key never fails later for a fixable reason. */
  async function checkSettings(provider: ProviderId, settings: { accountId?: string | null; model?: string | null; effort?: string | null }): Promise<string | undefined> {
    const adapter = gateway.providerRegistry.get(provider);
    if (settings.effort) {
      if (!adapter?.tuning?.efforts.includes(settings.effort)) return `Effort must be one of: ${adapter?.tuning?.efforts.join(', ') || 'none for this provider'}`;
    }
    if (settings.model && !adapter?.tuning) return 'This provider has no model setting';
    if (settings.accountId) {
      const accounts = await adapter?.accounts?.list().catch(() => []);
      if (!accounts?.some((a) => a.id === settings.accountId)) return 'Unknown account for this provider';
    }
    return undefined;
  }

  app.get<{ Params: { id: string } }>('/v1/providers/:id/keys', pre, async (request, reply) => {
    if (!isProviderId(request.params.id)) return fail(reply, 404, 'Unknown provider');
    return { keys: gateway.providerKeys.list(request.params.id) };
  });

  app.post<{ Params: { id: string } }>('/v1/providers/:id/keys', pre, async (request, reply) => {
    const provider = request.params.id;
    if (!isProviderId(provider)) return fail(reply, 404, 'Unknown provider');
    const parsed = CreateBody.safeParse(request.body ?? {});
    if (!parsed.success) return fail(reply, 400, parsed.error.issues[0]!.message);
    const problem = await checkSettings(provider, parsed.data);
    if (problem) return fail(reply, 400, problem);
    return { key: gateway.providerKeys.create(provider, parsed.data) };
  });

  app.patch<{ Params: { id: string; keyId: string } }>('/v1/providers/:id/keys/:keyId', pre, async (request, reply) => {
    const provider = request.params.id;
    if (!isProviderId(provider)) return fail(reply, 404, 'Unknown provider');
    const parsed = PatchBody.safeParse(request.body ?? {});
    if (!parsed.success) return fail(reply, 400, parsed.error.issues[0]!.message);
    const problem = await checkSettings(provider, parsed.data);
    if (problem) return fail(reply, 400, problem);
    const key = gateway.providerKeys.update(provider, request.params.keyId, parsed.data as ProfilePatch);
    return key ? { key } : fail(reply, 404, 'Unknown key');
  });

  app.post<{ Params: { id: string; keyId: string } }>('/v1/providers/:id/keys/:keyId/rotate', pre, async (request, reply) => {
    if (!isProviderId(request.params.id)) return fail(reply, 404, 'Unknown provider');
    const key = gateway.providerKeys.rotateProfile(request.params.id, request.params.keyId);
    return key ? { key } : fail(reply, 404, 'Unknown key');
  });

  app.delete<{ Params: { id: string; keyId: string } }>('/v1/providers/:id/keys/:keyId', pre, async (request, reply) => {
    const provider = request.params.id;
    if (!isProviderId(provider)) return fail(reply, 404, 'Unknown provider');
    if (!gateway.providerKeys.byId(provider, request.params.keyId)) return fail(reply, 404, 'Unknown key');
    if (!gateway.providerKeys.delete(provider, request.params.keyId)) return fail(reply, 400, 'Each provider keeps at least one key; regenerate it instead');
    return { keys: gateway.providerKeys.list(provider) };
  });
}
