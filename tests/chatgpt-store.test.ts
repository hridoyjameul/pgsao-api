import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ChatGptCredentialStore, type ChatGptStoreState } from '../src/chatgpt/credential-store.js';
import { startTestApp, TEST_API_KEY } from './support/test-server.js';

const dirs: string[] = [];
async function pathForTest() {
  const root = await mkdtemp(join(tmpdir(), 'pgsao-chatgpt-'));
  dirs.push(root);
  return join(root, 'private', 'chatgpt.json');
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('protected ChatGPT account store', () => {
  it('keeps a stable urn:uuid host ID across reloads', async () => {
    const path = await pathForTest();
    const first = await new ChatGptCredentialStore(path).getOrCreateHostId();
    expect(first).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    expect(await new ChatGptCredentialStore(path).getOrCreateHostId()).toBe(first);
  });

  it('atomically saves two registrations and selected account', async () => {
    const path = await pathForTest();
    const store = new ChatGptCredentialStore(path);
    const hostId = await store.getOrCreateHostId();
    const account = (registrationId: string) => ({ registrationId, clientId: `client-${registrationId}`, issuer: 'https://auth.openai.com', subject: `sub-${registrationId}`, scopes: ['chatgpt.tokens.use.direct'], accessToken: `access-${registrationId}`, refreshToken: `refresh-${registrationId}`, idToken: `id-${registrationId}`, expiresAt: Date.now() + 3600000 });
    const state: ChatGptStoreState = { hostId, selectedRegistrationId: 'second', accounts: [account('first'), account('second')] };
    await store.save(state);
    expect(await new ChatGptCredentialStore(path).load()).toEqual(state);
    expect((await readFile(path, 'utf8')).includes('refresh-second')).toBe(true);
  });

  it('never exposes selected tokens in provider status', async () => {
    const path = await pathForTest();
    const store = new ChatGptCredentialStore(path);
    await store.save({ hostId: 'urn:uuid:5c3cb76b-3e1c-4d4c-9d14-87eb1839dc22', selectedRegistrationId: 'one', accounts: [{ registrationId: 'one', clientId: 'client', issuer: 'https://auth.openai.com', subject: 'subject', email: 'user@example.test', scopes: ['chatgpt.tokens.use.direct'], accessToken: 'sensitive-access', refreshToken: 'sensitive-refresh', idToken: 'sensitive-id', expiresAt: Date.now() + 3600000 }] });
    const ctx = await startTestApp({ CHATGPT_CREDENTIALS_PATH: path });
    try {
      const response = await ctx.app.inject({ method: 'GET', url: '/v1/providers', headers: { 'x-api-key': TEST_API_KEY } });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain('sensitive-');
      expect(response.json().providers[1].connection.state).toBe('connected');
      expect(response.json().providers[1].api.ready).toBe(false);
    } finally { await ctx.close(); }
  });

  it('rejects an existing insecure file or directory on load', async () => {
    if (process.platform === 'win32') return; // ACL-specific test is exercised through implementation checks on Windows.
    const path = await pathForTest();
    await mkdir(resolve(path, '..'), { recursive: true, mode: 0o777 });
    await chmod(resolve(path, '..'), 0o777);
    await writeFile(path, '{}', { mode: 0o666 });
    await chmod(path, 0o666);
    await expect(new ChatGptCredentialStore(path).load()).rejects.toThrow(/permission|insecure/i);
  });
});
