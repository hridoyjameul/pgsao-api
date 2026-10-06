import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatGptCredentialStore } from '../src/chatgpt/credential-store.js';
import { ChatGptConnection } from '../src/chatgpt/connection.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config/config.js';
import { FakeClaudeProvider } from './support/fake-claude-provider.js';
import { TEST_API_KEY } from './support/test-server.js';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture(expiresAt = Date.now() + 30_000) {
  const root = await mkdtemp(join(tmpdir(), 'pgsao-connection-'));
  dirs.push(root);
  const store = new ChatGptCredentialStore(join(root, 'private', 'chatgpt.json'));
  await store.save({ hostId: 'urn:uuid:5c3cb76b-3e1c-4d4c-9d14-87eb1839dc22', selectedRegistrationId: 'one', accounts: [{ registrationId: 'one', clientId: 'oaiapp_one', issuer: 'https://auth.openai.com', subject: 'sub', scopes: ['chatgpt.tokens.use.direct'], accessToken: 'old-access', refreshToken: 'old-refresh', idToken: 'old-id', expiresAt }] });
  let refreshCount = 0;
  let invalid = false;
  let revoked = false;
  const calls: Array<{ url: string; form: URLSearchParams }> = [];
  const http: typeof fetch = async (input, init) => {
    const url = String(input);
    const form = new URLSearchParams(String(init?.body));
    calls.push({ url, form });
    if (url.endsWith('/.well-known/openid-configuration')) return new Response(JSON.stringify({ revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke' }));
    if (url.endsWith('/oauth/revoke')) { revoked = true; return new Response(null, { status: 200 }); }
    if (url.endsWith('/oauth/token')) {
      refreshCount++;
      if (invalid) return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
      await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response(JSON.stringify({ access_token: 'new-access', refresh_token: 'new-refresh', id_token: 'new-id', scope: 'chatgpt.tokens.use.direct', expires_in: 3600 }));
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  return { store, http, calls, get refreshCount() { return refreshCount; }, get revoked() { return revoked; }, setInvalid: () => { invalid = true; } };
}

describe('ChatGPT connection lifecycle', () => {
  it('serializes refresh and persists all rotated fields before returning', async () => {
    const f = await fixture();
    const connection = new ChatGptConnection(f.store, f.http);
    expect(await Promise.all([connection.getAccessToken(), connection.getAccessToken()])).toEqual(['new-access', 'new-access']);
    expect(f.refreshCount).toBe(1);
    expect(f.calls[0]?.form.get('client_id')).toBe('oaiapp_one');
    expect(f.calls[0]?.form.get('scope')).toBeNull();
    expect((await f.store.load()).accounts[0]).toMatchObject({ accessToken: 'new-access', refreshToken: 'new-refresh', idToken: 'new-id' });
  });

  it('disconnects only ChatGPT after revoked refresh; Claude stays available', async () => {
    const f = await fixture();
    f.setInvalid();
    const connection = new ChatGptConnection(f.store, f.http);
    await expect(connection.getAccessToken()).rejects.toThrow(/reconnect/i);
    expect((await connection.status()).state).toBe('disconnected');
    const config = loadConfig({ GATEWAY_API_KEY: TEST_API_KEY, LOG_LEVEL: 'silent', CHATGPT_CREDENTIALS_PATH: f.store.path } as NodeJS.ProcessEnv);
    const app = await buildApp({ config, claudeProvider: new FakeClaudeProvider(), dbPath: ':memory:', chatGptFetch: f.http });
    try {
      const response = await app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: `Bearer ${TEST_API_KEY}` } });
      expect(response.statusCode).toBe(200);
      const providers = await app.inject({ method: 'GET', url: '/v1/providers', headers: { authorization: `Bearer ${TEST_API_KEY}` } });
      expect(providers.json().providers[0].api.ready).toBe(true);
      expect(providers.json().providers[1].connection.state).toBe('disconnected');
    } finally { await app.close(); }
  });

  it('revokes the refresh token then clears only its local credentials', async () => {
    const f = await fixture(Date.now() + 3600_000);
    const connection = new ChatGptConnection(f.store, f.http);
    expect(await connection.disconnect()).toEqual({ remoteRevocationConfirmed: true });
    expect(f.revoked).toBe(true);
    expect(f.calls.at(-1)?.form.get('token')).toBe('old-refresh');
    expect((await f.store.load()).accounts[0]).toMatchObject({ clientId: 'oaiapp_one', accessToken: '', refreshToken: '', idToken: '' });
  });
});
