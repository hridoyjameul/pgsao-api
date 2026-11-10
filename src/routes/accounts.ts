import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { GatewayDeps } from '../app.js';
import { isProviderId } from '../auth/provider-keys.js';
import { UnknownAccountError } from '../accounts/types.js';
import { isValidAccountLabel } from '../kimi/connection.js';
import type { ProviderId } from '../providers/registry.js';
import { DEFAULT_CLAUDE_ACCOUNT, type NewClaudeAccount, type StoredClaudeAccount } from '../claude/accounts.js';
import type { AccountSummary } from '../accounts/types.js';
import type { CredentialStatus } from '../providers/types.js';
import { isValidLoginCode } from '../claude/login.js';

type Params = { id: string; accountId: string };

/** How long a sign-in that matched an existing account waits for the user's choice. */
const DUPLICATE_TTL_MS = 15 * 60_000;
const DUPLICATE_ACTIONS = ['keep_old', 'replace', 'keep_both'] as const;
type DuplicateAction = (typeof DUPLICATE_ACTIONS)[number];

interface PendingDuplicate {
  account: StoredClaudeAccount;
  status: CredentialStatus;
  existingId: string;
  activate: boolean;
  timer: ReturnType<typeof setTimeout>;
}

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

  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>('/v1/providers/:id/fallback', pre, async (request, reply) => {
    const fallback = accountsOf(request.params.id)?.fallback;
    if (!fallback) return notFound(reply, 'This provider has no account fallback');
    const body = request.body;
    if (!body || typeof body !== 'object' || Object.keys(body).some((k) => k !== 'enabled') || typeof body.enabled !== 'boolean') {
      return badRequest(reply, 'Send { enabled: true } or { enabled: false }');
    }
    await fallback.set(body.enabled);
    return { enabled: await fallback.enabled() };
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
    return 'error' in added ? badRequest(reply, added.error) : 'duplicate' in added ? duplicateReply(reply, added) : added;
  });

  const claudeList = () => gateway.providerRegistry.get('claude')!.accounts!;
  const duplicates = new Map<string, PendingDuplicate>();
  const takeDuplicate = async (pendingId: string, keepLogin: boolean) => {
    const pending = duplicates.get(pendingId);
    if (!pending) return undefined;
    duplicates.delete(pendingId);
    clearTimeout(pending.timer);
    if (!keepLogin && pending.account.type === 'config_dir') await gateway.claudeLogins.removeFolder(pending.account.configDir);
    return pending;
  };
  app.addHook('onClose', async () => { await Promise.all([...duplicates.keys()].map((id) => takeDuplicate(id, false))); });

  /** The listed account signed in as `email`, by its live check or the address saved when it last worked. */
  async function findSameLogin(email: string): Promise<AccountSummary | undefined> {
    for (const account of await claudeList().list()) {
      const status = gateway.credentialMonitor.statusFor(account.id);
      const known = (status.ok ? status.email : undefined) ?? await gateway.claudeAccounts.emailOf(account.id);
      if (known && known.toLowerCase() === email.toLowerCase()) return account;
    }
    return undefined;
  }

  type Duplicate = { duplicate: { pendingId: string; email: string; existing: AccountSummary } };

  function duplicateReply(reply: FastifyReply, found: Duplicate) {
    const { email, existing } = found.duplicate;
    return reply.code(409).send({
      error: { type: 'duplicate_account', message: `${email} is already added as "${existing.label}". Keep the old login, replace it with this one, or keep both.` },
      ...found,
    });
  }

  async function saveClaudeAccount(account: StoredClaudeAccount, status: CredentialStatus, activate: boolean) {
    await gateway.claudeAccounts.add(account, activate);
    gateway.credentialMonitor.record(account.id, status);
    if (activate) gateway.credentialMonitor.setActive(account.id);
    return { accountId: account.id, accounts: await claudeList().list() };
  }

  /** Verifies a Claude login, then saves it as an account (active unless told otherwise), or holds it when that person is already listed. */
  async function addClaudeAccount(input: NewClaudeAccount, activate = true): Promise<{ error: string } | Duplicate | { accountId: string; accounts: unknown }> {
    let prepared;
    try { prepared = await gateway.claudeAccounts.prepare(input); } catch (error) { return { error: (error as Error).message }; }
    const status = await gateway.claudeProvider.checkCredentials(prepared.auth);
    if (!status.ok) return { error: `Claude did not accept this login: ${status.message}` };
    if (status.email) prepared.account.email = status.email;
    if (!input.label?.trim() && status.email) prepared.account.label = status.email;
    const existing = status.email ? await findSameLogin(status.email) : undefined;
    if (!existing) return saveClaudeAccount(prepared.account, status, activate);
    const pendingId = randomUUID();
    const timer = setTimeout(() => void takeDuplicate(pendingId, false), DUPLICATE_TTL_MS);
    timer.unref?.();
    duplicates.set(pendingId, { account: prepared.account, status, existingId: existing.id, activate, timer });
    return { duplicate: { pendingId, email: status.email!, existing } };
  }

  // A sign-in that matched a listed account: keep the old login, swap in the new one, or keep both.
  app.post<{ Params: { pendingId: string }; Body: Record<string, unknown> }>('/v1/providers/claude/accounts/duplicates/:pendingId', pre, async (request, reply) => {
    const body = request.body;
    if (!body || typeof body !== 'object' || Object.keys(body).some((k) => k !== 'action') || !DUPLICATE_ACTIONS.includes(body.action as DuplicateAction)) {
      return badRequest(reply, 'Send { action: "keep_old" | "replace" | "keep_both" }');
    }
    const action = body.action as DuplicateAction;
    const pending = await takeDuplicate(request.params.pendingId, action !== 'keep_old');
    if (!pending) return notFound(reply, 'This sign-in expired; sign in again');
    const { account, status, existingId, activate } = pending;
    const store = gateway.claudeAccounts;
    const stillListed = (await store.entries()).accounts.some((a) => a.id === existingId);
    if (action === 'keep_both' || !stillListed) return saveClaudeAccount(account, status, activate);
    if (action === 'keep_old') {
      if (activate) { await store.select(existingId); gateway.credentialMonitor.setActive(existingId); }
      return { accountId: existingId, accounts: await claudeList().list() };
    }
    const { accountId, replaced } = await store.replace(existingId, account);
    if (replaced?.type === 'config_dir') await gateway.claudeLogins.removeFolder(replaced.configDir);
    if (existingId === DEFAULT_CLAUDE_ACCOUNT) {
      gateway.providerKeys.repinAccount('claude', DEFAULT_CLAUDE_ACCOUNT, accountId);
      gateway.credentialMonitor.forget(DEFAULT_CLAUDE_ACCOUNT);
    }
    gateway.credentialMonitor.record(accountId, status);
    if (activate) await store.select(accountId);
    gateway.credentialMonitor.setActive((await store.entries()).selectedId);
    return { accountId, accounts: await claudeList().list() };
  });

  // Puts this computer's own Claude login back after it was removed from the list.
  app.post('/v1/providers/claude/accounts/machine-login', pre, async (_request, reply) => {
    if ((await gateway.claudeAccounts.entries()).accounts.some((a) => a.id === DEFAULT_CLAUDE_ACCOUNT)) return { accountId: DEFAULT_CLAUDE_ACCOUNT, accounts: await claudeList().list() };
    const status = await gateway.claudeProvider.checkCredentials();
    const email = status.ok ? status.email : await gateway.claudeAccounts.emailOf(DEFAULT_CLAUDE_ACCOUNT);
    const existing = email ? await findSameLogin(email) : undefined;
    if (existing) return badRequest(reply, `This computer's login (${email}) is already added as "${existing.label}"`);
    await gateway.claudeAccounts.restoreMachineLogin();
    gateway.credentialMonitor.record(DEFAULT_CLAUDE_ACCOUNT, status);
    gateway.credentialMonitor.setActive(DEFAULT_CLAUDE_ACCOUNT);
    return { accountId: DEFAULT_CLAUDE_ACCOUNT, accounts: await claudeList().list() };
  });

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
    return 'duplicate' in added ? duplicateReply(reply, added) : added;
  });

  app.delete<{ Params: { loginId: string } }>('/v1/providers/claude/login/:loginId', pre, async (request) => {
    await gateway.claudeLogins.cancel(request.params.loginId);
    return { cancelled: true };
  });
}
