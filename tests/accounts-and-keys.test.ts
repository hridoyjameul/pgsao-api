import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config/config.js';
import { ChatGptCredentialStore, type ChatGptAccount } from '../src/chatgpt/credential-store.js';
import { KimiKeyStore } from '../src/kimi/connection.js';
import { ProviderKeyStore } from '../src/auth/provider-keys.js';
import { FakeClaudeProvider } from './support/fake-claude-provider.js';
import { TEST_API_KEY } from './support/test-server.js';
import { SecureJsonFile } from '../src/accounts/secure-file.js';

const master = { authorization: `Bearer ${TEST_API_KEY}` };
const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
const chat = { model: 'claude-via-gateway', messages: [{ role: 'user', content: 'Hi' }] };
const TOKEN = 'sk-ant-oat01-work-account-token-0000';
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

function chatGptAccount(id: string, token: string, email: string): ChatGptAccount {
  return { registrationId: id, clientId: `oaiapp_${id}`, issuer: 'https://auth.openai.com', subject: `sub-${id}`, email, planType: 'plus', scopes: ['chatgpt.tokens.use.direct'], accessToken: token, refreshToken: `refresh-${id}`, idToken: 'id', expiresAt: Date.now() + 3600_000 };
}

async function fixture(opts: { chatgpt?: boolean; claudeLoginCommand?: { file: string; args: string[] } } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pgsao-accounts-'));
  dirs.push(root);
  const chatGptStore = new ChatGptCredentialStore(join(root, 'private', 'chatgpt.json'));
  if (opts.chatgpt) {
    await chatGptStore.save({ hostId: 'urn:uuid:5c3cb76b-3e1c-4d4c-9d14-87eb1839dc22', selectedRegistrationId: 'one', accounts: [chatGptAccount('one', 'token-one', 'one@example.test'), chatGptAccount('two', 'token-two', 'two@example.test')] });
  }
  const calls: Array<{ url: string; auth: string | null; body: string | undefined }> = [];
  const http: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(input), auth: headers.get('authorization'), body: init?.body === undefined ? undefined : String(init.body) });
    if (String(input).endsWith('/responses')) {
      return new Response('event: response.completed\ndata: {"type":"response.completed"}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    }
    // Revocation discovery: no endpoint, so removal stays local.
    if (String(input).includes('openid-configuration')) return new Response('{}', { headers: { 'content-type': 'application/json' } });
    return new Response('{"data":[]}', { headers: { 'content-type': 'application/json' } });
  };
  const config = loadConfig({
    GATEWAY_API_KEY: TEST_API_KEY, LOG_LEVEL: 'silent',
    CHATGPT_CREDENTIALS_PATH: chatGptStore.path,
    KIMI_KEY_PATH: join(root, 'private', 'kimi.json'),
    CLAUDE_ACCOUNTS_PATH: join(root, 'private', 'claude-accounts.json'),
  } as NodeJS.ProcessEnv);
  const claudeProvider = new FakeClaudeProvider();
  claudeProvider.tokenStatuses.set(TOKEN, { ok: true, email: 'work@example.test', subscriptionType: 'max' });
  const app = await buildApp({ config, claudeProvider, dbPath: join(root, 'gateway.db'), chatGptStore, chatGptFetch: http, kimiFetch: http, claudeLoginCommand: opts.claudeLoginCommand });
  const inject = (method: string, url: string, payload?: unknown, headers: Record<string, string> = master) =>
    app.inject({ method: method as 'GET', url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
  const provider = async (id: string) => (await inject('GET', '/v1/providers')).json().providers.find((p: { id: string }) => p.id === id);
  return { app, root, calls, claudeProvider, inject, provider };
}

describe('API keys per provider', () => {
  it('creates, edits, rotates and deletes keys, keeping at least one', async () => {
    const f = await fixture();
    try {
      const first = (await f.inject('GET', '/v1/providers/claude/keys')).json().keys;
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({ name: 'Default', provider: 'claude' });
      expect((await f.inject('GET', '/v1/providers/claude/key')).json().apiKey).toBe(first[0].key);

      const created = (await f.inject('POST', '/v1/providers/claude/keys', { name: 'n8n', model: 'claude-opus-5', effort: 'high' })).json().key;
      expect(created).toMatchObject({ name: 'n8n', model: 'claude-opus-5', effort: 'high' });
      expect(created.key).toMatch(/^sk-pgsao-claude-/);
      expect((await f.inject('GET', '/v1/providers/claude/keys')).json().keys).toHaveLength(2);

      const patched = (await f.inject('PATCH', `/v1/providers/claude/keys/${created.id}`, { effort: null, model: 'claude-sonnet-5' })).json().key;
      expect(patched.effort).toBeUndefined();
      expect(patched.model).toBe('claude-sonnet-5');

      const rotated = (await f.inject('POST', `/v1/providers/claude/keys/${created.id}/rotate`)).json().key;
      expect(rotated.key).not.toBe(created.key);
      expect((await f.inject('POST', '/v1/chat/completions', chat, bearer(created.key))).statusCode).toBe(401);
      expect((await f.inject('POST', '/v1/chat/completions', chat, bearer(rotated.key))).statusCode).toBe(200);

      expect((await f.inject('DELETE', `/v1/providers/claude/keys/${created.id}`)).statusCode).toBe(200);
      expect((await f.inject('DELETE', `/v1/providers/claude/keys/${first[0].id}`)).statusCode).toBe(400);
      expect((await f.inject('DELETE', '/v1/providers/claude/keys/nope')).statusCode).toBe(404);
    } finally { await f.app.close(); }
  });

  it('rejects settings the provider cannot honor and needs the master key', async () => {
    const f = await fixture();
    try {
      expect((await f.inject('POST', '/v1/providers/claude/keys', { effort: 'turbo' })).statusCode).toBe(400);
      expect((await f.inject('POST', '/v1/providers/chatgpt/keys', { effort: 'max' })).statusCode).toBe(400);
      expect((await f.inject('POST', '/v1/providers/claude/keys', { accountId: 'nobody' })).statusCode).toBe(400);
      expect((await f.inject('POST', '/v1/providers/claude/keys', { model: 'bad model!' })).statusCode).toBe(400);
      expect((await f.inject('POST', '/v1/providers/claude/keys', { secret: 'x' })).statusCode).toBe(400);
      expect((await f.inject('POST', '/v1/providers/gemini/keys', { model: 'gemini-x' })).statusCode).toBe(400);
      const key = (await f.inject('GET', '/v1/providers/claude/keys')).json().keys[0].key;
      expect((await f.inject('GET', '/v1/providers/claude/keys', undefined, bearer(key))).statusCode).toBe(401);
      expect((await f.inject('GET', '/v1/providers/claude/keys', undefined, {})).statusCode).toBe(401);
    } finally { await f.app.close(); }
  });

  it('applies a key\'s model and effort to Claude requests; the master key changes nothing', async () => {
    const f = await fixture();
    try {
      const key = (await f.inject('POST', '/v1/providers/claude/keys', { model: 'claude-opus-5', effort: 'max' })).json().key.key;
      const res = await f.inject('POST', '/claude/v1/chat/completions', { ...chat, model: 'claude-sonnet-5' }, bearer(key));
      expect(res.statusCode).toBe(200);
      expect(f.claudeProvider.lastRequest).toMatchObject({ model: 'claude-opus-5', effort: 'max', auth: { accountId: 'default' } });

      // A fixed model also works when the app sends a model name the gateway does not know.
      const anthropic = await f.inject('POST', '/claude/v1/messages', { model: 'whatever-the-app-says', max_tokens: 16, messages: [{ role: 'user', content: 'Hi' }] }, { 'x-api-key': key });
      expect(anthropic.statusCode).toBe(200);
      expect(f.claudeProvider.lastRequest?.model).toBe('claude-opus-5');

      const off = (await f.inject('POST', '/v1/providers/claude/keys', { model: 'claude-via-gateway', effort: 'off' })).json().key.key;
      await f.inject('POST', '/v1/chat/completions', { ...chat, model: 'unknown-model' }, bearer(off));
      expect(f.claudeProvider.lastRequest).toMatchObject({ model: undefined, effort: 'off' });

      await f.inject('POST', '/v1/chat/completions', chat);
      expect(f.claudeProvider.lastRequest?.effort).toBeUndefined();
      expect((await f.inject('POST', '/v1/chat/completions', { ...chat, model: 'unknown-model' })).statusCode).toBe(400);
    } finally { await f.app.close(); }
  });

  it('migrates a single-key file without breaking existing keys', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pgsao-keys-'));
    dirs.push(dir);
    const path = join(dir, 'provider-keys.json');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path, JSON.stringify({ claude: 'sk-pgsao-claude-legacy', kimi: 'sk-pgsao-kimi-legacy' }));
    const store = new ProviderKeyStore(path);
    expect(store.matches('claude', 'sk-pgsao-claude-legacy')).toBe(true);
    expect(store.list('kimi')[0]).toMatchObject({ name: 'Default', key: 'sk-pgsao-kimi-legacy' });
    expect(JSON.parse(await readFile(path, 'utf8')).version).toBe(2);
    expect(new ProviderKeyStore(path).get('claude')).toBe('sk-pgsao-claude-legacy');
  });
});

describe('Claude accounts', () => {
  it('lists the machine login, adds a token account, switches and pins keys to accounts', async () => {
    const f = await fixture();
    try {
      let claude = await f.provider('claude');
      expect(claude.accounts).toEqual([{ id: 'default', label: "test@example.com (this computer's login)", detail: 'Claude API', active: true, connected: true }]);
      expect(claude.tuning.efforts).toEqual(['off', 'low', 'medium', 'high', 'xhigh', 'max']);

      expect((await f.inject('POST', '/v1/providers/claude/accounts', { token: 'sk-ant-oat01-not-a-real-login-xx' })).statusCode).toBe(400);
      expect((await f.inject('POST', '/v1/providers/claude/accounts', { token: TOKEN, configDir: '/x' })).statusCode).toBe(400);
      const added = await f.inject('POST', '/v1/providers/claude/accounts', { token: TOKEN });
      expect(added.statusCode).toBe(200);
      const workId = added.json().accountId as string;
      expect(JSON.stringify(added.json())).not.toContain(TOKEN);

      claude = await f.provider('claude');
      expect(claude.accounts.map((a: { label: string; active: boolean }) => [a.label, a.active])).toEqual([["test@example.com (this computer's login)", false], ['work@example.test', true]]);
      expect(claude.connection.detail).toBe('work@example.test - max');
      expect(JSON.stringify(claude)).not.toContain(TOKEN);
      expect(await readFile(join(f.root, 'private', 'claude-accounts.json'), 'utf8')).toContain(TOKEN);

      await f.inject('POST', '/v1/chat/completions', chat);
      expect(f.claudeProvider.lastRequest?.auth?.accountId).toBe(workId);
      expect(f.claudeProvider.lastRequest?.auth?.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);

      // Switch back to the machine login; a key pinned to the work account keeps using it.
      expect((await f.inject('POST', '/v1/providers/claude/accounts/default/select')).statusCode).toBe(200);
      const pinned = (await f.inject('POST', '/v1/providers/claude/keys', { accountId: workId })).json().key;
      await f.inject('POST', '/v1/chat/completions', chat);
      expect(f.claudeProvider.lastRequest?.auth).toEqual({ accountId: 'default' });
      await f.inject('POST', '/v1/chat/completions', chat, bearer(pinned.key));
      expect(f.claudeProvider.lastRequest?.auth?.accountId).toBe(workId);

      expect((await f.inject('POST', '/v1/providers/claude/accounts/nope/select')).statusCode).toBe(404);
      expect((await f.inject('DELETE', `/v1/providers/claude/accounts/${workId}`)).statusCode).toBe(200);
      // The pin is cleared, so the key falls back to the active account instead of failing.
      const after = (await f.inject('GET', '/v1/providers/claude/keys')).json().keys.find((k: { id: string }) => k.id === pinned.id);
      expect(after.accountId).toBeUndefined();
      await f.inject('POST', '/v1/chat/completions', chat, bearer(pinned.key));
      expect(f.claudeProvider.lastRequest?.auth).toEqual({ accountId: 'default' });
    } finally { await f.app.close(); }
  });

  it('refuses requests for an account whose login has stopped working', async () => {
    const f = await fixture();
    try {
      const workId = (await f.inject('POST', '/v1/providers/claude/accounts', { token: TOKEN, label: 'Work' })).json().accountId;
      f.claudeProvider.tokenStatuses.set(TOKEN, { ok: false, message: 'Not logged in' });
      await f.app.gateway.credentialMonitor.checkNow();
      const res = await f.inject('POST', '/v1/chat/completions', chat);
      expect(res.statusCode).toBe(503);
      expect((await f.provider('claude')).accounts.find((a: { id: string }) => a.id === workId)).toMatchObject({ label: 'Work', connected: false, detail: 'Not logged in' });
    } finally { await f.app.close(); }
  });
});

describe('Claude account removal, duplicates and fallback', () => {
  const OTHER = 'sk-ant-oat01-other-account-token-000';
  const SAME_AS_MACHINE = 'sk-ant-oat01-same-as-machine-token-00';
  const labels = async (f: Awaited<ReturnType<typeof fixture>>) =>
    (await f.provider('claude')).accounts.map((a: { label: string; active: boolean }) => [a.label, a.active]);

  it('removes the machine login once another account exists, and can put it back', async () => {
    const f = await fixture();
    try {
      expect((await f.inject('DELETE', '/v1/providers/claude/accounts/default')).json().error.message).toMatch(/Add another Claude account/);
      const workId = (await f.inject('POST', '/v1/providers/claude/accounts', { token: TOKEN, activate: false })).json().accountId;
      const pinned = (await f.inject('POST', '/v1/providers/claude/keys', { accountId: 'default' })).json().key;

      expect((await f.inject('DELETE', '/v1/providers/claude/accounts/default')).statusCode).toBe(200);
      expect(await labels(f)).toEqual([['work@example.test', true]]);
      await f.inject('POST', '/v1/chat/completions', chat, bearer(pinned.key));
      expect(f.claudeProvider.lastRequest?.auth?.accountId).toBe(workId);
      // The only account left cannot be removed.
      expect((await f.inject('DELETE', `/v1/providers/claude/accounts/${workId}`)).statusCode).toBe(400);
      expect((await f.inject('POST', '/v1/providers/claude/accounts/default/select')).statusCode).toBe(404);

      expect((await f.inject('POST', '/v1/providers/claude/accounts/machine-login')).statusCode).toBe(200);
      expect(await labels(f)).toEqual([["test@example.com (this computer's login)", true], ['work@example.test', false]]);
    } finally { await f.app.close(); }
  });

  it('asks before adding a login that is already listed: keep old, replace, or keep both', async () => {
    const f = await fixture();
    f.claudeProvider.tokenStatuses.set(SAME_AS_MACHINE, { ok: true, email: 'TEST@example.com', subscriptionType: 'pro' });
    try {
      const pinned = (await f.inject('POST', '/v1/providers/claude/keys', { accountId: 'default' })).json().key;
      const ask = async () => {
        const res = await f.inject('POST', '/v1/providers/claude/accounts', { token: SAME_AS_MACHINE });
        expect(res.statusCode).toBe(409);
        expect(res.json().duplicate).toMatchObject({ email: 'TEST@example.com', existing: { id: 'default' } });
        expect(JSON.stringify(res.json())).not.toContain(SAME_AS_MACHINE);
        return res.json().duplicate.pendingId as string;
      };
      const choose = (pendingId: string, action: string) => f.inject('POST', `/v1/providers/claude/accounts/duplicates/${pendingId}`, { action });

      // Keep old: nothing is added.
      const first = await ask();
      expect((await choose(first, 'keep_old')).statusCode).toBe(200);
      expect(await labels(f)).toEqual([["test@example.com (this computer's login)", true]]);
      expect((await choose(first, 'keep_old')).statusCode).toBe(404);
      expect((await choose(await ask(), 'maybe')).statusCode).toBe(400);

      // Replace: the new login takes the machine login's place, active state and pinned keys.
      expect((await choose(await ask(), 'replace')).statusCode).toBe(200);
      expect(await labels(f)).toEqual([['TEST@example.com', true]]);
      await f.inject('POST', '/v1/chat/completions', chat, bearer(pinned.key));
      expect(f.claudeProvider.lastRequest?.auth?.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe(SAME_AS_MACHINE);

      // A login matching a stored account replaces it in place: same id, name and pins.
      const accountId = (await f.provider('claude')).accounts[0].id;
      f.claudeProvider.tokenStatuses.set(OTHER, { ok: true, email: 'test@example.com' });
      const again = await f.inject('POST', '/v1/providers/claude/accounts', { token: OTHER });
      expect(again.json().duplicate.existing.id).toBe(accountId);
      expect((await choose(again.json().duplicate.pendingId, 'replace')).json().accountId).toBe(accountId);
      await f.inject('POST', '/v1/chat/completions', chat, bearer(pinned.key));
      expect(f.claudeProvider.lastRequest?.auth).toMatchObject({ accountId, env: { CLAUDE_CODE_OAUTH_TOKEN: OTHER } });

      // Keep both; the machine login cannot come back as a third copy.
      const both = await f.inject('POST', '/v1/providers/claude/accounts', { token: SAME_AS_MACHINE });
      expect((await choose(both.json().duplicate.pendingId, 'keep_both')).statusCode).toBe(200);
      expect((await f.provider('claude')).accounts).toHaveLength(2);
      expect((await f.inject('POST', '/v1/providers/claude/accounts/machine-login')).json().error.message).toMatch(/already added/);
    } finally { await f.app.close(); }
  });

  it('recognizes a duplicate of an account whose login has expired', async () => {
    const f = await fixture();
    try {
      const workId = (await f.inject('POST', '/v1/providers/claude/accounts', { token: TOKEN })).json().accountId;
      f.claudeProvider.tokenStatuses.set(TOKEN, { ok: false, message: 'OAuth token has expired' });
      await f.app.gateway.credentialMonitor.checkNow();
      f.claudeProvider.tokenStatuses.set(OTHER, { ok: true, email: 'work@example.test' });
      const res = await f.inject('POST', '/v1/providers/claude/accounts', { token: OTHER });
      expect(res.statusCode).toBe(409);
      expect(res.json().duplicate.existing).toMatchObject({ id: workId, connected: false });
    } finally { await f.app.close(); }
  });

  it('moves to the next account at a usage limit when fallback is on', async () => {
    const f = await fixture();
    try {
      f.claudeProvider.tokenStatuses.set(OTHER, { ok: true, email: 'other@example.test' });
      const workId = (await f.inject('POST', '/v1/providers/claude/accounts', { token: TOKEN })).json().accountId;
      const otherId = (await f.inject('POST', '/v1/providers/claude/accounts', { token: OTHER, activate: false })).json().accountId;
      f.claudeProvider.usageLimited.add(workId);

      // Off by default: the limit reaches the caller.
      expect((await f.provider('claude')).fallback).toBe(false);
      expect((await f.inject('POST', '/v1/chat/completions', chat)).statusCode).toBe(429);

      expect((await f.inject('PUT', '/v1/providers/claude/fallback', { enabled: 'yes' })).statusCode).toBe(400);
      expect((await f.inject('PUT', '/v1/providers/claude/fallback', { enabled: true })).json()).toEqual({ enabled: true });
      expect((await f.provider('claude')).fallback).toBe(true);

      const ok = await f.inject('POST', '/v1/chat/completions', chat);
      expect(ok.statusCode).toBe(200);
      expect(f.claudeProvider.lastRequest?.auth?.accountId).toBe('default');

      // Streaming moves too, and the refused account's start event never reaches the caller.
      f.claudeProvider.usageLimited.add('default');
      const streamed = await f.inject('POST', '/v1/messages', { model: 'claude-sonnet-5', max_tokens: 50, stream: true, messages: [{ role: 'user', content: 'Hi' }] });
      expect(streamed.statusCode).toBe(200);
      expect(streamed.body).not.toContain('limited-session');
      expect(streamed.body).toContain('message_stop');
      expect(f.claudeProvider.lastRequest?.auth?.accountId).toBe(otherId);

      // A conversation kept with session_id stays on its account.
      expect((await f.inject('POST', '/v1/chat/completions', { ...chat, session_id: 'kept-session' })).statusCode).toBe(429);

      // Every account at its limit: the caller gets the limit error.
      f.claudeProvider.usageLimited.add(otherId);
      expect((await f.inject('POST', '/v1/chat/completions', chat)).statusCode).toBe(429);

      // An active account whose login stopped working is skipped too.
      f.claudeProvider.usageLimited.clear();
      f.claudeProvider.tokenStatuses.set(TOKEN, { ok: false, message: 'Not logged in' });
      await f.app.gateway.credentialMonitor.checkNow();
      expect((await f.inject('POST', '/v1/chat/completions', chat)).statusCode).toBe(200);
      expect(f.claudeProvider.lastRequest?.auth?.accountId).toBe('default');
    } finally { await f.app.close(); }
  });
});

describe('ChatGPT accounts', () => {
  it('switches and removes accounts, and pinned keys send that account\'s token, model and reasoning effort', async () => {
    const f = await fixture({ chatgpt: true });
    try {
      const chatgpt = await f.provider('chatgpt');
      expect(chatgpt.accounts).toEqual([
        { id: 'one', label: 'one@example.test', detail: 'Plus plan', active: true, connected: true },
        { id: 'two', label: 'two@example.test', detail: 'Plus plan', active: false, connected: true },
      ]);
      const body = { model: 'gpt-app', input: [{ role: 'user', content: 'Hi' }], store: false, stream: true };
      await f.inject('POST', '/chatgpt/v1/responses', body);
      expect(f.calls.at(-1)?.auth).toBe('Bearer token-one');

      expect((await f.inject('POST', '/v1/providers/chatgpt/accounts/two/select')).json().accounts[1].active).toBe(true);
      await f.inject('POST', '/chatgpt/v1/responses', body);
      expect(f.calls.at(-1)?.auth).toBe('Bearer token-two');

      const key = (await f.inject('POST', '/v1/providers/chatgpt/keys', { accountId: 'one', model: 'gpt-fixed', effort: 'high' })).json().key.key;
      const res = await f.inject('POST', '/chatgpt/v1/responses', { ...body, reasoning: { effort: 'low', summary: 'auto' } }, bearer(key));
      expect(res.statusCode).toBe(200);
      expect(f.calls.at(-1)?.auth).toBe('Bearer token-one');
      expect(JSON.parse(f.calls.at(-1)!.body!)).toMatchObject({ model: 'gpt-fixed', reasoning: { effort: 'high', summary: 'auto' } });
      expect((await f.inject('POST', '/chatgpt/v1/responses', { ...body, reasoning: { effort: 'turbo' } })).statusCode).toBe(400);

      expect((await f.inject('DELETE', '/v1/providers/chatgpt/accounts/two')).statusCode).toBe(200);
      const after = await f.provider('chatgpt');
      expect(after.accounts).toEqual([{ id: 'one', label: 'one@example.test', detail: 'Plus plan', active: true, connected: true }]);
      expect(after.connection.state).toBe('connected');
    } finally { await f.app.close(); }
  });
});

// Stands in for `claude auth login`: prints a sign-in link, waits for a code, writes a
// credentials file into CLAUDE_CONFIG_DIR, and fails on the code "wrong-code-x".
const FAKE_LOGIN = [
  "const fs = require('fs'); const path = require('path');",
  "process.stdout.write('Opening browser to sign in\\nIf the browser did not open, visit: https://claude.com/cai/oauth/authorize?code=true&state=abc\\nPaste code here if prompted > ');",
  "let input = ''; process.stdin.on('data', (d) => { input += d; if (input.includes('\\n')) {",
  "  const code = input.trim(); if (code === 'wrong-code-x') { console.error('Invalid code'); process.exit(1); }",
  "  fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json'), JSON.stringify({ code })); process.exit(0); } });",
].join('\n');

describe('Claude browser sign-in', () => {
  async function loginFixture() {
    const f = await fixture({ claudeLoginCommand: { file: process.execPath, args: ['-e', FAKE_LOGIN, '--'] } });
    const start = async () => (await f.inject('POST', '/v1/providers/claude/login')).json() as { loginId: string; url: string };
    return { ...f, start };
  }

  it('signs in from the dashboard with a pasted code and keeps the login in a private folder', async () => {
    const f = await loginFixture();
    try {
      const { loginId, url } = await f.start();
      expect(url).toBe('https://claude.com/cai/oauth/authorize?code=true&state=abc');
      const done = await f.inject('POST', `/v1/providers/claude/login/${loginId}`, { code: 'good-code-123#state', label: 'Work' });
      expect(done.statusCode).toBe(200);
      const accounts = (await f.provider('claude')).accounts;
      expect(accounts.map((a: { label: string; active: boolean }) => [a.label, a.active])).toEqual([["test@example.com (this computer's login)", false], ['Work', true]]);
      const dir = join(f.root, 'private', 'claude-logins', loginId);
      expect(JSON.parse(await readFile(join(dir, '.credentials.json'), 'utf8'))).toEqual({ code: 'good-code-123#state' });
      await f.inject('POST', '/v1/chat/completions', chat);
      expect(f.claudeProvider.lastRequest?.auth?.env?.CLAUDE_CONFIG_DIR).toBe(dir);

      // Removing the account deletes the login folder it came with.
      await f.inject('DELETE', `/v1/providers/claude/accounts/${done.json().accountId}`);
      await expect(readFile(join(dir, '.credentials.json'))).rejects.toThrow();
    } finally { await f.app.close(); }
  });

  it('holds a sign-in of an already listed account until the user chooses, and drops its folder when the old login is kept', async () => {
    const f = await loginFixture();
    try {
      const first = await f.start();
      expect((await f.inject('POST', `/v1/providers/claude/login/${first.loginId}`, { code: 'good-code-123' })).statusCode).toBe(200);
      const second = await f.start();
      const dup = await f.inject('POST', `/v1/providers/claude/login/${second.loginId}`, { code: 'good-code-456' });
      expect(dup.statusCode).toBe(409);
      expect(dup.json().duplicate).toMatchObject({ email: 'folder@example.test', existing: { label: 'folder@example.test' } });
      const dir = join(f.root, 'private', 'claude-logins', second.loginId);
      expect(await readFile(join(dir, '.credentials.json'), 'utf8')).toContain('good-code-456');

      await f.inject('POST', `/v1/providers/claude/accounts/duplicates/${dup.json().duplicate.pendingId}`, { action: 'keep_old' });
      await expect(readFile(join(dir, '.credentials.json'))).rejects.toThrow();
      expect((await f.provider('claude')).accounts).toHaveLength(2);
    } finally { await f.app.close(); }
  });

  it('reports a rejected code, cleans up, and supports cancelling', async () => {
    const f = await loginFixture();
    try {
      const first = await f.start();
      const bad = await f.inject('POST', `/v1/providers/claude/login/${first.loginId}`, { code: 'wrong-code-x' });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error.message).toMatch(/did not accept that code/);
      expect((await f.inject('POST', `/v1/providers/claude/login/${first.loginId}`, { code: 'good-code-123' })).json().error.message).toMatch(/expired/);
      expect((await f.inject('POST', `/v1/providers/claude/login/${first.loginId}`, { code: 'x' })).statusCode).toBe(400);

      const second = await f.start();
      expect((await f.inject('DELETE', `/v1/providers/claude/login/${second.loginId}`)).statusCode).toBe(200);
      expect((await f.provider('claude')).accounts).toHaveLength(1);
      expect((await f.inject('POST', '/v1/providers/claude/login', undefined, {})).statusCode).toBe(401);
    } finally { await f.app.close(); }
  });
});

describe('ChatGPT sign-in return address', () => {
  it('returns to the loopback address the sign-in started from, never to another host', async () => {
    const f = await fixture();
    try {
      const start = async (host: string) => {
        const res = await f.app.inject({ method: 'POST', url: '/v1/providers/chatgpt/connect', headers: { ...master, host }, payload: {} });
        return new URL(res.json().authorizationUrl).searchParams.get('state')!;
      };
      const back = async (state: string) => (await f.app.inject({ method: 'GET', url: `/auth/callback?state=${state}&error=access_denied`, headers: { host: '127.0.0.1:8787' } })).headers.location;
      expect(await back(await start('localhost:8787'))).toBe('http://localhost:8787/dashboard?chatgpt=failed');
      expect(await back(await start('127.0.0.1:8787'))).toBe('/dashboard?chatgpt=failed');
      expect(await back(await start('evil.example:8787'))).toBe('/dashboard?chatgpt=failed');
      expect(await back('unknown-state')).toBe('/dashboard?chatgpt=failed');
    } finally { await f.app.close(); }
  });
});

describe('Kimi accounts', () => {
  it('keeps several membership keys, switches between them and applies thinking per key', async () => {
    const f = await fixture();
    try {
      const firstId = (await f.inject('POST', '/v1/providers/kimi/credentials', { apiKey: 'sk-kimi-first-1111', label: 'Personal' })).json().accountId;
      const secondId = (await f.inject('POST', '/v1/providers/kimi/credentials', { apiKey: 'sk-kimi-second-2222' })).json().accountId;
      const kimi = await f.provider('kimi');
      expect(kimi.accounts).toEqual([
        { id: firstId, label: 'Personal', detail: 'Key ending 1111', active: false, connected: true },
        { id: secondId, label: 'Kimi account 2', detail: 'Key ending 2222', active: true, connected: true },
      ]);
      expect(JSON.stringify(kimi)).not.toContain('sk-kimi-first');

      const payload = { model: 'kimi-for-coding', messages: [{ role: 'user', content: 'Hi' }] };
      await f.inject('POST', '/kimi/v1/chat/completions', payload);
      expect(f.calls.at(-1)?.auth).toBe('Bearer sk-kimi-second-2222');

      const key = (await f.inject('POST', '/v1/providers/kimi/keys', { accountId: firstId, model: 'kimi-for-coding-highspeed', effort: 'off' })).json().key.key;
      await f.inject('POST', '/kimi/v1/chat/completions', payload, bearer(key));
      expect(f.calls.at(-1)?.auth).toBe('Bearer sk-kimi-first-1111');
      expect(JSON.parse(f.calls.at(-1)!.body!)).toMatchObject({ model: 'kimi-for-coding-highspeed', thinking: { type: 'disabled' } });

      const on = (await f.inject('POST', '/v1/providers/kimi/keys', { effort: 'on' })).json().key.key;
      await f.inject('POST', '/kimi/v1/messages', { model: 'kimi-for-coding', max_tokens: 100, messages: [{ role: 'user', content: 'Hi' }] }, { 'x-api-key': on });
      expect(JSON.parse(f.calls.at(-1)!.body!)).toMatchObject({ max_tokens: 4096, thinking: { type: 'enabled', budget_tokens: 3072 } });

      await f.inject('POST', `/v1/providers/kimi/accounts/${firstId}/select`);
      await f.inject('POST', '/kimi/v1/chat/completions', payload);
      expect(f.calls.at(-1)?.auth).toBe('Bearer sk-kimi-first-1111');
      await f.inject('DELETE', `/v1/providers/kimi/accounts/${firstId}`);
      expect((await f.provider('kimi')).accounts.map((a: { id: string; active: boolean }) => [a.id, a.active])).toEqual([[secondId, true]]);
    } finally { await f.app.close(); }
  });

  it('reads a key file saved before multiple accounts existed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pgsao-kimi-legacy-'));
    dirs.push(dir);
    const path = join(dir, 'private', 'kimi.json');
    await new SecureJsonFile(path, (v) => v).write({ apiKey: 'sk-kimi-legacy-9999' });
    const state = await new KimiKeyStore(path).load();
    expect(state).toEqual({ selectedId: 'default', accounts: [{ id: 'default', label: 'Kimi account', apiKey: 'sk-kimi-legacy-9999' }] });
  });
});
