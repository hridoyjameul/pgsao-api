import type { GatewayDeps } from '../app.js';
import type { ApiKeyProfile } from '../auth/provider-keys.js';
import { ApiError } from '../errors/api-error.js';
import { resolveModelAlias } from '../config/models.js';
import { CLAUDE_EFFORTS, type ClaudeAuth, type ClaudeEffort, type ClaudeProvider, type InternalClaudeEvent, type InternalClaudeRequest, type InternalClaudeResponse } from '../providers/types.js';

export interface ClaudeRequestContext {
  auth: ClaudeAuth;
  /** Accounts to move to, in order, when `auth` hits its usage limit. Empty unless fallback is on. */
  fallbacks: ClaudeAuth[];
  /** Replaces the request's `model` (bypassing the alias allow-list — the owner chose it). `resolved: undefined` = SDK default model. */
  model?: { resolved: string | undefined };
  effort?: ClaudeEffort;
}

/** Every other listed account with a working login, in list order. */
async function fallbackAccounts(gateway: GatewayDeps, primaryId: string): Promise<ClaudeAuth[]> {
  if (!(await gateway.claudeAccounts.fallbackEnabled())) return [];
  const { accounts } = await gateway.claudeAccounts.entries();
  const usable = accounts.filter((a) => a.id !== primaryId && gateway.credentialMonitor.statusFor(a.id).ok);
  const auths = await Promise.all(usable.map((a) => gateway.claudeAccounts.resolve(a.id).catch(() => undefined)));
  return auths.filter((a): a is ClaudeAuth => a !== undefined);
}

/** Resolves which Claude account and settings a request runs with, from the API key it presented. */
export async function claudeRequestContext(gateway: GatewayDeps, profile?: ApiKeyProfile): Promise<ClaudeRequestContext> {
  let auth: ClaudeAuth;
  try { auth = await gateway.claudeAccounts.resolve(profile?.accountId); } catch {
    throw new ApiError('credential_error', 'The Claude account this API key uses was removed; pick another account for the key');
  }
  const fallbacks = await fallbackAccounts(gateway, auth.accountId);
  // With fallback on, an account whose login stopped working is skipped instead of failing the request.
  if (!gateway.credentialMonitor.statusFor(auth.accountId).ok && fallbacks.length) auth = fallbacks.shift()!;
  gateway.credentialMonitor.assertValid(auth.accountId);
  const effort = (CLAUDE_EFFORTS as readonly string[]).includes(profile?.effort ?? '') ? profile!.effort as ClaudeEffort : undefined;
  // A gateway alias (e.g. claude-sonnet-5) maps to its real model; anything else is passed through as a model ID.
  const model = profile?.model ? (resolveModelAlias(profile.model) ?? { resolved: profile.model }) : undefined;
  return { auth, fallbacks, ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

/**
 * Accounts to try for one call. A conversation kept with `session_id` lives
 * in one account's Claude Code history, so it never moves to another account.
 */
function accountsFor(request: InternalClaudeRequest, context: ClaudeRequestContext, usesSession: boolean): ClaudeAuth[] {
  return usesSession || request.resumeSessionId ? [context.auth] : [context.auth, ...context.fallbacks];
}

const isUsageLimit = (err: unknown) => err instanceof ApiError && err.category === 'usage_limit_error';

/** Sends a Claude call, moving to the next fallback account while the current one is at its usage limit. */
export async function sendWithFallback(provider: ClaudeProvider, request: InternalClaudeRequest, context: ClaudeRequestContext, usesSession = false): Promise<InternalClaudeResponse> {
  const accounts = accountsFor(request, context, usesSession);
  for (let i = 0; ; i++) {
    try { return await provider.sendMessage({ ...request, auth: accounts[i] }); } catch (err) {
      if (!isUsageLimit(err) || i === accounts.length - 1) throw err;
    }
  }
}

/**
 * Streaming twin of sendWithFallback. The leading `start` event is held back
 * until real output arrives, so a usage-limit refusal can still move to the
 * next account before anything reaches the caller.
 */
export async function* streamWithFallback(provider: ClaudeProvider, request: InternalClaudeRequest, context: ClaudeRequestContext, usesSession = false): AsyncIterable<InternalClaudeEvent> {
  const accounts = accountsFor(request, context, usesSession);
  for (let i = 0; ; i++) {
    const events = provider.streamMessage({ ...request, auth: accounts[i] })[Symbol.asyncIterator]();
    const held: InternalClaudeEvent[] = [];
    let done = false;
    try {
      while (!done) {
        const next = await events.next();
        if (next.done) done = true;
        else { held.push(next.value); if (next.value.type !== 'start') break; }
      }
    } catch (err) {
      if (!isUsageLimit(err) || i === accounts.length - 1) throw err;
      continue;
    }
    yield* held;
    if (done) return;
    for (let next = await events.next(); !next.done; next = await events.next()) yield next.value;
    return;
  }
}
