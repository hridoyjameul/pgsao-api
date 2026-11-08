import type { GatewayDeps } from '../app.js';
import type { ApiKeyProfile } from '../auth/provider-keys.js';
import { ApiError } from '../errors/api-error.js';
import { resolveModelAlias } from '../config/models.js';
import { CLAUDE_EFFORTS, type ClaudeAuth, type ClaudeEffort } from '../providers/types.js';

export interface ClaudeRequestContext {
  auth: ClaudeAuth;
  /** Replaces the request's `model` (bypassing the alias allow-list — the owner chose it). `resolved: undefined` = SDK default model. */
  model?: { resolved: string | undefined };
  effort?: ClaudeEffort;
}

/** Resolves which Claude account and settings a request runs with, from the API key it presented. */
export async function claudeRequestContext(gateway: GatewayDeps, profile?: ApiKeyProfile): Promise<ClaudeRequestContext> {
  let auth: ClaudeAuth;
  try { auth = await gateway.claudeAccounts.resolve(profile?.accountId); } catch {
    throw new ApiError('credential_error', 'The Claude account this API key uses was removed; pick another account for the key');
  }
  gateway.credentialMonitor.assertValid(auth.accountId);
  const effort = (CLAUDE_EFFORTS as readonly string[]).includes(profile?.effort ?? '') ? profile!.effort as ClaudeEffort : undefined;
  // A gateway alias (e.g. claude-sonnet-5) maps to its real model; anything else is passed through as a model ID.
  const model = profile?.model ? (resolveModelAlias(profile.model) ?? { resolved: profile.model }) : undefined;
  return { auth, ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}
