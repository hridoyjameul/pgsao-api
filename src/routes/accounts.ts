import type { FastifyInstance, FastifyReply } from 'fastify';
import type { GatewayDeps } from '../app.js';
import { isProviderId } from '../auth/provider-keys.js';
import { UnknownAccountError } from '../accounts/types.js';
import { isValidAccountLabel } from '../kimi/connection.js';
import type { ProviderId } from '../providers/registry.js';
import type { NewClaudeAccount } from '../claude/accounts.js';
import { isValidLoginCode } from '../claude/login.js';

type Params = { id: string; accountId: string };

function notFound(reply: FastifyReply, message: string) {
  return reply.code(404).send({ error: { type: 'not_found_error', message } });
}

function badRequest(reply: FastifyReply, message: string) {
  return reply.code(400).send({ error: { type: 'invalid_request_error', message } });
}

/**
 * Account list / switch / remove for every provider with account support,
 * plus adding a Claude account. Adding ChatGPT (OAuth, routes/chatgpt-auth.ts)
 * and Kimi (vendor key, routes/kimi.ts) accounts stays with their own flows.
 */
export function registerAccountRoutes(app: FastifyInstance, gateway: GatewayDeps): void {
  const pre = { preHandler: gateway.requireApiKey };
  const accountsOf = (id: string) => (isProviderId(id) ? gateway.providerRegistry.get(id)?.accounts : undefined);

  app.get<{ Params: { id: string } }>('/v1/providers/:id/accounts', pre, async (request, reply) => {
    const accounts = accountsOf(request.params.id);
    if (!accounts) return notFound(reply, 'This provider has no accounts');
    return { accounts: await accounts.list() };
  });

  app.post<{ Params: Params }>('/v1/providers/:id/accounts/:accountId/select', pre, async (request, reply) => {
    const accounts = accountsOf(request.params.id);
    if (!accounts) return notFound(reply, 'This provider has no accounts');
    try { await accounts.select(request.params.accountId); } catch (error) {
      if (error instanceof UnknownAccountError) return notFound(reply, 'Unknown account');
      throw error;
    }
    return { accounts: await accounts.list() };
  });

  app.delete<{ Params: Params }>('/v1/providers/:id/accounts/:accountId', pre, async (request, reply) => {
    const accounts = accountsOf(request.params.id);
    if (!accounts) return notFound(reply, 'This provider has no accounts');
    try { await accounts.remove(request.params.accountId); } catch (error) {
      if (error instanceof UnknownAccountError) return notFound(reply, 'Unknown account');
      return badRequest(reply, (error as Error).message);
    }
    // Keys pinned to the removed account fall back to the active account.
    gateway.providerKeys.unpinAccount(request.params.id as ProviderId, request.params.accountId);
    return { accounts: await accounts.list() };
  });

  app.post<{ Body: Record<string, unknown> }>('/v1/providers/claude/accounts', pre, async (request, reply) => {
    const body = request.body;
    const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : null;
    const hasToken = typeof body?.token === 'string';
    const hasDir = typeof body?.configDir === 'string';
    if (!keys || keys.some((k) => !['label', 'token', 'configDir', 'activate'].includes(k)) || hasToken === hasDir
      || (body.label !== undefined && body.label !== '' && !isValidAccountLabel(body.label))
      || (body.activate !== undefined && typeof body.activate !== 'boolean')) {
      return badRequest(reply, 'Send { label?, token } or { label?, configDir }');
    }
    const label = typeof body.label === 'string' ? body.label : undefined;
    const input = hasToken ? { label, token: (body.token as string).trim() } : { label, configDir: (body.configDir as string).trim() };
    const added = await addClaudeAccount(input, body.activate !== false);
    return 'error' in added ? badRequest(reply, added.error) : added;
  });

  /** Verifies a Claude login, then saves it as an account (active unless told otherwise). */
  async function addClaudeAccount(input: NewClaudeAccount, activate = true): Promise<{ error: string } | { accountId: string; accounts: unknown }> {
    let prepared;
    try { prepared = await gateway.claudeAccounts.prepare(input); } catch (error) { return { error: (error as Error).message }; }
    const status = await gateway.claudeProvider.checkCredentials(prepared.auth);
    if (!status.ok) return { error: `Claude did not accept this login: ${status.message}` };
    if (!input.label?.trim() && status.email) prepared.account.label = status.email;
    await gateway.claudeAccounts.add(prepared.account, activate);
    gateway.credentialMonitor.record(prepared.account.id, status);
    if (activate) gateway.credentialMonitor.setActive(prepared.account.id);
    return { accountId: prepared.account.id, accounts: await gateway.providerRegistry.get('claude')!.accounts!.list() };
  }

  // Browser sign-in: no terminal. Start returns the claude.ai link; finishing takes the code claude.ai shows.
  app.post('/v1/providers/claude/login', pre, async (_request, reply) => {
    if (!gateway.claudeLogins.available) return reply.code(501).send({ error: { type: 'provider_error', message: 'Claude sign-in is not available in this install; use a setup token instead' } });
    try { return await gateway.claudeLogins.start(); } catch (error) {
      return reply.code(502).send({ error: { type: 'provider_error', message: (error as Error).message } });
    }
  });

  app.post<{ Params: { loginId: string }; Body: Record<string, unknown> }>('/v1/providers/claude/login/:loginId', pre, async (request, reply) => {
    const body = request.body;
    if (!body || typeof body !== 'object' || Object.keys(body).some((k) => k !== 'code' && k !== 'label') || !isValidLoginCode(body.code)
      || (body.label !== undefined && body.label !== '' && !isValidAccountLabel(body.label))) {
      return badRequest(reply, 'Paste the code Claude showed after signing in');
    }
    let configDir: string;
    try { configDir = await gateway.claudeLogins.finish(request.params.loginId, body.code as string); } catch (error) {
      return badRequest(reply, (error as Error).message);
    }
    const added = await addClaudeAccount({ label: typeof body.label === 'string' ? body.label : undefined, configDir });
    if ('error' in added) { await gateway.claudeLogins.removeFolder(configDir); return badRequest(reply, added.error); }
    return added;
  });

  app.delete<{ Params: { loginId: string } }>('/v1/providers/claude/login/:loginId', pre, async (request) => {
    await gateway.claudeLogins.cancel(request.params.loginId);
    return { cancelled: true };
  });
}
