import { afterEach, describe, expect, it } from 'vitest';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config/config.js';
import { FakeClaudeProvider } from './support/fake-claude-provider.js';
import { TEST_API_KEY } from './support/test-server.js';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pgsao-oauth-'));
  dirs.push(root);
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-key';
  const tokenCalls: URLSearchParams[] = [];
  let tokenOverride: Record<string, unknown> = {};
  let responseStatus = 200;
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === 'https://auth.openai.com/.well-known/openid-configuration') return new Response(JSON.stringify({ issuer: 'https://auth.openai.com', jwks_uri: 'https://auth.openai.com/.well-known/jwks.json' }));
    if (url === 'https://auth.openai.com/.well-known/jwks.json') return new Response(JSON.stringify({ keys: [jwk] }));
    if (url === 'https://auth.openai.com/api/accounts/oauth/token') {
      const form = new URLSearchParams(String(init?.body));
      tokenCalls.push(form);
      if (responseStatus !== 200) return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: responseStatus });
      const idToken = await new SignJWT({ nonce: currentNonce, email: 'owner@example.test', ...tokenOverride })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setIssuer('https://auth.openai.com')
        .setAudience(form.get('client_id')!).setSubject('owner-sub').setIssuedAt().setExpirationTime('1h').sign(privateKey);
      return new Response(JSON.stringify({ access_token: 'access-secret', refresh_token: 'refresh-secret', id_token: idToken, scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct', expires_in: 3600 }));
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  let currentNonce = '';
  const config = loadConfig({ GATEWAY_API_KEY: TEST_API_KEY, LOG_LEVEL: 'silent', CHATGPT_CREDENTIALS_PATH: join(root, 'private', 'chatgpt.json') } as NodeJS.ProcessEnv);
  const app = await buildApp({ config, claudeProvider: new FakeClaudeProvider(), dbPath: ':memory:', chatGptFetch: fakeFetch });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const auth = { authorization: `Bearer ${TEST_API_KEY}` };
  const connect = async (registrationId?: string) => {
    const res = await app.inject({ method: 'POST', url: '/v1/providers/chatgpt/connect', headers: auth, payload: registrationId ? { registrationId } : {} });
    expect(res.statusCode).toBe(200);
    const url = new URL(res.json().authorizationUrl);
    currentNonce = url.searchParams.get('nonce')!;
    return url;
  };
  const callback = (url: URL, extra: Record<string, string> = {}) => {
    const query = new URLSearchParams({ code: 'short-lived-code', state: url.searchParams.get('state')!, client_id: 'oaiapp_issued', ...extra });
    return app.inject({ method: 'GET', url: `/auth/callback?${query}` });
  };
  return { app, auth, connect, callback, tokenCalls, setTokenOverride: (value: Record<string, unknown>) => { tokenOverride = value; }, setStatus: (status: number) => { responseStatus = status; } };
}

describe('ChatGPT local OAuth', () => {
  it('requires the gateway key and builds an exact dynamic registration request', async () => {
    const f = await fixture();
    try {
      expect((await f.app.inject({ method: 'POST', url: '/v1/providers/chatgpt/connect' })).statusCode).toBe(401);
      const url = await f.connect();
      expect(url.origin + url.pathname).toBe('https://auth.openai.com/api/accounts/authorize');
      expect(url.searchParams.get('client_id')).toBe('dynamic_agent_client');
      expect(url.searchParams.get('agent_name_hint')).toBe('PGSAO API');
      expect(url.searchParams.get('ext_agent_host_id')).toMatch(/^urn:uuid:/);
      expect(url.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
      expect(url.searchParams.get('scope')).toBe('openid profile email offline_access resource.invoke chatgpt.tokens.use.direct');
      expect(url.searchParams.get('resource')).toBe('https://api.openai.com/v1');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('state')).toBeTruthy();
      expect(url.searchParams.get('nonce')).toBeTruthy();
    } finally { await f.app.close(); }
  });

  it('validates once, saves issued client ID and redirects without secrets', async () => {
    const f = await fixture();
    try {
      const url = await f.connect();
      const response = await f.callback(url);
      expect(response.statusCode).toBe(303);
      expect(response.headers.location).toBe('/dashboard?chatgpt=connected');
      expect(JSON.stringify(response.headers)).not.toContain('short-lived-code');
      expect(response.body).not.toContain('access-secret');
      expect(f.tokenCalls[0]?.get('client_id')).toBe('oaiapp_issued');
      expect(f.tokenCalls[0]?.get('redirect_uri')).toBe(url.searchParams.get('redirect_uri'));
      expect(f.tokenCalls[0]?.get('code_verifier')).toBeTruthy();
      expect((await f.callback(url)).headers.location).toBe('/dashboard?chatgpt=failed');
      const store = await f.app.gateway.chatGptStore.load();
      expect(store.accounts).toHaveLength(1);
      expect(store.accounts[0]?.clientId).toBe('oaiapp_issued');
      expect(store.selectedRegistrationId).toBe(store.accounts[0]?.registrationId);
      const providers = await f.app.inject({ method: 'GET', url: '/v1/providers', headers: f.auth });
      expect(providers.body).not.toContain('access-secret');
    } finally { await f.app.close(); }
  });

  it('rejects wrong state, denied consent, changed client ID, invalid grant and wrong nonce', async () => {
    const f = await fixture();
    try {
      const first = await f.connect();
      expect((await f.callback(first, { state: 'wrong' })).headers.location).toBe('/dashboard?chatgpt=failed');
      expect((await f.app.inject({ method: 'GET', url: `/auth/callback?state=${first.searchParams.get('state')}&error=access_denied` })).headers.location).toBe('/dashboard?chatgpt=failed');
      expect((await f.callback(first)).headers.location).toBe('/dashboard?chatgpt=failed');
      const second = await f.connect();
      expect((await f.callback(second, { client_id: 'dynamic_agent_client' })).headers.location).toBe('/dashboard?chatgpt=failed');
      const third = await f.connect();
      f.setStatus(400);
      expect((await f.callback(third)).headers.location).toBe('/dashboard?chatgpt=failed');
      f.setStatus(200);
      const fourth = await f.connect();
      f.setTokenOverride({ nonce: 'wrong' });
      expect((await f.callback(fourth)).headers.location).toBe('/dashboard?chatgpt=failed');
      expect((await f.app.gateway.chatGptStore.load()).accounts).toHaveLength(0);
    } finally { await f.app.close(); }
  });
});
