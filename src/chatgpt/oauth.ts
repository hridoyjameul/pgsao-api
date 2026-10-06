import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
import type { ChatGptAccount, ChatGptCredentialStore } from './credential-store.js';

const ISSUER = 'https://auth.openai.com';
const AUTHORIZE = `${ISSUER}/api/accounts/authorize`;
const TOKEN = `${ISSUER}/api/accounts/oauth/token`;
const DISCOVERY = `${ISSUER}/.well-known/openid-configuration`;
export const CHATGPT_RESOURCE = 'https://api.openai.com/v1';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';

interface PendingAttempt {
  registrationId: string;
  existing?: ChatGptAccount;
  redirectUri: string;
  nonce: string;
  verifier: string;
  expiresAt: number;
}

export type OAuthFetch = typeof fetch;

async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  const body = await response.text();
  if (body.length > 256_000) throw new Error('OAuth response too large');
  const parsed: unknown = JSON.parse(body);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid OAuth response');
  return parsed as Record<string, unknown>;
}

export function planTypeFromClaims(payload: Record<string, unknown>): string | undefined {
  const auth = payload['https://api.openai.com/auth'];
  const nested = auth && typeof auth === 'object' ? (auth as Record<string, unknown>).chatgpt_plan_type : undefined;
  const value = typeof nested === 'string' ? nested : payload.chatgpt_plan_type;
  return typeof value === 'string' && /^[a-z0-9_ -]{1,32}$/i.test(value) ? value.toLowerCase() : undefined;
}

export class ChatGptOAuth {
  private readonly pending = new Map<string, PendingAttempt>();

  constructor(private readonly store: ChatGptCredentialStore, private readonly http: OAuthFetch = fetch) {}

  async start(redirectUri: string, registrationId?: string): Promise<string> {
    if (!/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/.test(redirectUri)) throw new Error('Invalid ChatGPT callback URI');
    const hostId = await this.store.getOrCreateHostId();
    const current = await this.store.load();
    const existing = registrationId ? current.accounts.find((a) => a.registrationId === registrationId) : undefined;
    if (registrationId && !existing) throw new Error('Unknown ChatGPT registration');
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const verifier = randomBytes(64).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const attempt: PendingAttempt = { registrationId: existing?.registrationId ?? randomUUID(), existing, redirectUri, nonce, verifier, expiresAt: Date.now() + 600_000 };
    for (const [key, value] of this.pending) if (value.expiresAt < Date.now()) this.pending.delete(key);
    this.pending.set(state, attempt);
    const url = new URL(AUTHORIZE);
    url.searchParams.set('client_id', existing?.clientId ?? 'dynamic_agent_client');
    if (!existing) url.searchParams.set('agent_name_hint', 'PGSAO API');
    else if (existing.email) url.searchParams.set('login_hint', existing.email);
    url.searchParams.set('ext_agent_host_id', hostId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', SCOPES);
    url.searchParams.set('resource', CHATGPT_RESOURCE);
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('code_challenge', challenge);
    return url.toString();
  }

  async complete(query: Record<string, unknown>): Promise<boolean> {
    const state = typeof query.state === 'string' ? query.state : '';
    const attempt = this.pending.get(state);
    if (!attempt) return false;
    this.pending.delete(state);
    if (Date.now() > attempt.expiresAt || query.error || typeof query.code !== 'string' || !query.code) return false;
    const callbackClientId = typeof query.client_id === 'string' ? query.client_id : undefined;
    const clientId = attempt.existing?.clientId ?? callbackClientId;
    if (!clientId || clientId === 'dynamic_agent_client' || (attempt.existing && callbackClientId && callbackClientId !== clientId)) return false;
    try {
      const form = new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code: query.code, code_verifier: attempt.verifier, redirect_uri: attempt.redirectUri, resource: CHATGPT_RESOURCE });
      const tokenResponse = await this.http(TOKEN, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form, redirect: 'error', signal: AbortSignal.timeout(15_000) });
      if (!tokenResponse.ok) return false;
      const tokens = await boundedJson(tokenResponse);
      if (typeof tokens.access_token !== 'string' || typeof tokens.refresh_token !== 'string' || typeof tokens.id_token !== 'string'
        || typeof tokens.scope !== 'string' || typeof tokens.expires_in !== 'number' || tokens.expires_in <= 0) return false;
      const scopes = tokens.scope.split(/\s+/).filter(Boolean);
      if (!scopes.includes('chatgpt.tokens.use.direct')) return false;
      const discoveryResponse = await this.http(DISCOVERY, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
      if (!discoveryResponse.ok) return false;
      const discovery = await boundedJson(discoveryResponse);
      if (discovery.issuer !== ISSUER || typeof discovery.jwks_uri !== 'string') return false;
      const jwksUrl = new URL(discovery.jwks_uri);
      if (jwksUrl.origin !== ISSUER || jwksUrl.protocol !== 'https:') return false;
      const jwksResponse = await this.http(jwksUrl.toString(), { redirect: 'error', signal: AbortSignal.timeout(10_000) });
      if (!jwksResponse.ok) return false;
      const jwks = await boundedJson(jwksResponse) as unknown as JSONWebKeySet;
      if (!Array.isArray(jwks.keys)) return false;
      const verified = await jwtVerify(tokens.id_token, createLocalJWKSet(jwks), { issuer: ISSUER, audience: clientId, requiredClaims: ['exp', 'sub', 'nonce'] });
      if (verified.payload.nonce !== attempt.nonce || typeof verified.payload.sub !== 'string' || !verified.payload.sub) return false;
      if (attempt.existing && (attempt.existing.issuer !== ISSUER || attempt.existing.subject !== verified.payload.sub)) return false;
      const account: ChatGptAccount = {
        registrationId: attempt.registrationId, clientId, issuer: ISSUER, subject: verified.payload.sub,
        ...(typeof verified.payload.email === 'string' ? { email: verified.payload.email } : {}),
        ...(planTypeFromClaims(verified.payload) ? { planType: planTypeFromClaims(verified.payload) } : {}),
        scopes, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, idToken: tokens.id_token,
        expiresAt: Date.now() + tokens.expires_in * 1000,
      };
      await this.store.update((current) => {
        current.accounts = [...current.accounts.filter((a) => a.registrationId !== account.registrationId), account];
        current.selectedRegistrationId = account.registrationId;
      });
      return true;
    } catch {
      return false;
    }
  }
}
