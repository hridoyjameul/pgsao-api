import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import { ChatGptCredentialStore } from '../src/chatgpt/credential-store.js';
import { loadConfig } from '../src/config/config.js';
import { FakeClaudeProvider } from './support/fake-claude-provider.js';
import { TEST_API_KEY } from './support/test-server.js';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture(connected = true, upstreamStatus = 200) {
  const root = await mkdtemp(join(tmpdir(), 'pgsao-models-'));
  dirs.push(root);
  const store = new ChatGptCredentialStore(join(root, 'private', 'chatgpt.json'));
  if (connected) await store.save({ hostId: 'urn:uuid:5c3cb76b-3e1c-4d4c-9d14-87eb1839dc22', selectedRegistrationId: 'one', accounts: [{ registrationId: 'one', clientId: 'oaiapp_one', issuer: 'https://auth.openai.com', subject: 'sub', scopes: ['chatgpt.tokens.use.direct'], accessToken: 'selected-secret', refreshToken: 'refresh-secret', idToken: 'id-secret', expiresAt: Date.now() + 3600_000 }] });
  const calls: Array<{ url: string; auth: string | null }> = [];
  const http: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(input), auth: headers.get('authorization') });
    return new Response(JSON.stringify({ models: [
      { slug: 'gpt-one', display_name: 'GPT One', visibility: 'list' },
      { slug: 'hidden', display_name: 'Hidden', visibility: 'hidden' },
      { slug: 'gpt-two', display_name: 'GPT Two', visibility: 'list' },
    ] }), { status: upstreamStatus });
  };
  const config = loadConfig({ GATEWAY_API_KEY: TEST_API_KEY, LOG_LEVEL: 'silent', CHATGPT_CREDENTIALS_PATH: store.path } as NodeJS.ProcessEnv);
  const app = await buildApp({ config, claudeProvider: new FakeClaudeProvider(), dbPath: ':memory:', chatGptFetch: http });
  return { app, calls };
}

describe('ChatGPT selected-account models', () => {
  it('filters listed models in order with fixed upstream URL and OAuth header', async () => {
    const f = await fixture();
    try {
      expect((await f.app.inject({ method: 'GET', url: '/chatgpt/v1/models' })).statusCode).toBe(401);
      const response = await f.app.inject({ method: 'GET', url: '/chatgpt/v1/models', headers: { authorization: `Bearer ${TEST_API_KEY}` } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ models: [{ slug: 'gpt-one', display_name: 'GPT One' }, { slug: 'gpt-two', display_name: 'GPT Two' }] });
      expect(f.calls).toEqual([{ url: 'https://api.openai.com/v1/models', auth: 'Bearer selected-secret' }]);
      expect(response.body).not.toContain('selected-secret');
    } finally { await f.app.close(); }
  });

  it('fails independently when disconnected or upstream rejects the account', async () => {
    const disconnected = await fixture(false);
    try {
      const response = await disconnected.app.inject({ method: 'GET', url: '/chatgpt/v1/models', headers: { 'x-api-key': TEST_API_KEY } });
      expect(response.statusCode).toBe(503);
      expect(disconnected.calls).toHaveLength(0);
    } finally { await disconnected.app.close(); }
    const rejected = await fixture(true, 401);
    try {
      const response = await rejected.app.inject({ method: 'GET', url: '/chatgpt/v1/models', headers: { 'x-api-key': TEST_API_KEY } });
      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain('selected-secret');
    } finally { await rejected.app.close(); }
  });
});
