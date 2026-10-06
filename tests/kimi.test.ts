import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config/config.js';
import { GATEWAY_VERSION } from '../src/utils/version.js';
import { FakeClaudeProvider } from './support/fake-claude-provider.js';
import { TEST_API_KEY } from './support/test-server.js';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

const KIMI_KEY = 'sk-kimi-membership-secret-1234';
const sseBody = 'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n\n';

interface Call { url: string; method: string; headers: Headers; body: string | undefined }

async function fixture(respond: (call: Call) => Response = () => new Response('{"data":[]}', { headers: { 'content-type': 'application/json' } })) {
  const root = await mkdtemp(join(tmpdir(), 'pgsao-kimi-'));
  dirs.push(root);
  const calls: Call[] = [];
  const http: typeof fetch = async (input, init) => {
    const call = { url: String(input), method: String(init?.method), headers: new Headers(init?.headers), body: init?.body === undefined ? undefined : String(init.body) };
    calls.push(call);
    return respond(call);
  };
  const config = loadConfig({
    GATEWAY_API_KEY: TEST_API_KEY, LOG_LEVEL: 'silent',
    CHATGPT_CREDENTIALS_PATH: join(root, 'private', 'chatgpt.json'),
    KIMI_KEY_PATH: join(root, 'private', 'kimi.json'),
  } as NodeJS.ProcessEnv);
  const app = await buildApp({ config, claudeProvider: new FakeClaudeProvider(), dbPath: ':memory:', kimiFetch: http });
  const auth = { authorization: `Bearer ${TEST_API_KEY}` };
  const saveKey = (apiKey: string = KIMI_KEY) => app.inject({ method: 'POST', url: '/v1/providers/kimi/credentials', headers: auth, payload: { apiKey } });
  const chat = (payload: unknown = { model: 'kimi-for-coding', messages: [{ role: 'user', content: 'Hello' }] }) =>
    app.inject({ method: 'POST', url: '/kimi/v1/chat/completions', headers: auth, payload: payload as object });
  const messages = (payload: unknown = { model: 'kimi-for-coding', max_tokens: 16, messages: [{ role: 'user', content: 'Hello' }] }) =>
    app.inject({ method: 'POST', url: '/kimi/v1/messages', headers: { 'x-api-key': TEST_API_KEY }, payload: payload as object });
  const providers = async () => (await app.inject({ method: 'GET', url: '/v1/providers', headers: auth })).json().providers.find((p: { id: string }) => p.id === 'kimi');
  const usage = () => app.inject({ method: 'GET', url: '/v1/usage', headers: auth });
  return { app, calls, root, saveKey, chat, messages, providers, usage, keyPath: join(root, 'private', 'kimi.json') };
}

describe('Kimi membership-key provider', () => {
  it('starts needing a key and rejects calls without calling Kimi', async () => {
    const f = await fixture();
    try {
      const status = await f.providers();
      expect(status.connection.state).toBe('not_configured');
      expect(status.setupAction).toBe('enter_key');
      expect(status.api.ready).toBe(false);
      expect((await f.chat()).statusCode).toBe(503);
      expect(f.calls).toHaveLength(0);
    } finally { await f.app.close(); }
  });

  it('requires the gateway key on every Kimi route', async () => {
    const f = await fixture();
    try {
      expect((await f.app.inject({ method: 'POST', url: '/kimi/v1/chat/completions', payload: { model: 'm' } })).statusCode).toBe(401);
      expect((await f.app.inject({ method: 'GET', url: '/kimi/v1/models' })).statusCode).toBe(401);
      expect((await f.app.inject({ method: 'POST', url: '/v1/providers/kimi/credentials', payload: { apiKey: KIMI_KEY } })).statusCode).toBe(401);
      expect((await f.app.inject({ method: 'DELETE', url: '/v1/providers/kimi/credentials' })).statusCode).toBe(401);
    } finally { await f.app.close(); }
  });

  it('validates, stores privately and never exposes the key', async () => {
    const f = await fixture();
    try {
      expect((await f.saveKey()).statusCode).toBe(200);
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0]).toMatchObject({ url: 'https://api.kimi.com/coding/v1/models', method: 'GET' });
      const status = await f.providers();
      expect(status.connection).toEqual({ state: 'connected', detail: 'Key ending 1234' });
      expect(status.api.ready).toBe(true);
      expect(status.api.capabilities.map((c: { basePath: string }) => c.basePath)).toEqual(['/kimi/v1', '/kimi']);
      expect(JSON.stringify(status)).not.toContain(KIMI_KEY);
      expect(await readFile(f.keyPath, 'utf8')).toContain(KIMI_KEY);
    } finally { await f.app.close(); }
  });

  it('refuses a rejected key and a malformed key without saving', async () => {
    const f = await fixture(() => new Response('no', { status: 401 }));
    try {
      expect((await f.saveKey()).statusCode).toBe(400);
      expect((await f.saveKey('short')).statusCode).toBe(400);
      expect((await f.providers()).connection.state).toBe('not_configured');
    } finally { await f.app.close(); }
  });

  it('saves an unverifiable key when the model listing is not offered, but not on an outage', async () => {
    const notOffered = await fixture(() => new Response('', { status: 404 }));
    try { expect((await notOffered.saveKey()).statusCode).toBe(200); } finally { await notOffered.app.close(); }
    const down = await fixture(() => new Response('', { status: 500 }));
    try {
      expect((await down.saveKey()).statusCode).toBe(502);
      expect((await down.providers()).connection.state).toBe('not_configured');
    } finally { await down.app.close(); }
  });

  it('forwards chat completions with fixed upstream auth and an honest User-Agent', async () => {
    const f = await fixture((call) => call.url.endsWith('/chat/completions')
      ? new Response(sseBody, { headers: { 'content-type': 'text/event-stream' } })
      : new Response('{"data":[]}'));
    try {
      await f.saveKey();
      const payload = { model: 'kimi-for-coding', stream: true, messages: [{ role: 'user', content: 'Hello' }] };
      const res = await f.app.inject({
        method: 'POST', url: '/kimi/v1/chat/completions', payload,
        headers: { authorization: `Bearer ${TEST_API_KEY}`, 'user-agent': 'spoofed/9', 'x-api-key': 'caller-key' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/event-stream');
      expect(res.body).toBe(sseBody);
      const call = f.calls.at(-1)!;
      expect(call.url).toBe('https://api.kimi.com/coding/v1/chat/completions');
      expect(call.headers.get('authorization')).toBe(`Bearer ${KIMI_KEY}`);
      expect(call.headers.get('user-agent')).toBe(`PGSAO-API/${GATEWAY_VERSION}`);
      expect(call.body).toBe(JSON.stringify(payload));
      const stats = (await f.usage()).json();
      expect(stats.byProvider.kimi.ok).toBe(1);
      expect(stats.byRoute.openai.ok).toBe(1);
    } finally { await f.app.close(); }
  });

  it('forwards Anthropic-shape messages to the Anthropic-compatible endpoint', async () => {
    const f = await fixture((call) => call.url.endsWith('/messages')
      ? new Response('{"type":"message","content":[{"type":"text","text":"Hi"}]}', { headers: { 'content-type': 'application/json' } })
      : new Response('{"data":[]}'));
    try {
      await f.saveKey();
      const res = await f.messages();
      expect(res.statusCode).toBe(200);
      expect(res.json().type).toBe('message');
      const call = f.calls.at(-1)!;
      expect(call.url).toBe('https://api.kimi.com/coding/v1/messages');
      expect(call.headers.get('x-api-key')).toBe(KIMI_KEY);
      expect(call.headers.get('anthropic-version')).toBe('2023-06-01');
      expect((await f.usage()).json().byRoute.anthropic.ok).toBe(1);
    } finally { await f.app.close(); }
  });

  it('rejects a missing model before calling Kimi and lists the fixed models', async () => {
    const f = await fixture();
    try {
      await f.saveKey();
      const before = f.calls.length;
      expect((await f.chat({ messages: [] })).statusCode).toBe(400);
      expect((await f.messages({ messages: [] })).json()).toMatchObject({ type: 'error', error: { type: 'invalid_request_error' } });
      expect(f.calls).toHaveLength(before);
      const models = await f.app.inject({ method: 'GET', url: '/kimi/v1/models', headers: { authorization: `Bearer ${TEST_API_KEY}` } });
      expect(models.json().data.map((m: { id: string }) => m.id)).toEqual(['kimi-for-coding', 'kimi-for-coding-highspeed']);
    } finally { await f.app.close(); }
  });

  it('maps usage limits, rejected keys and outages without falling back to Claude', async () => {
    let status = 429;
    const f = await fixture((call) => call.url.endsWith('/models') ? new Response('{}') : new Response('x', { status, headers: status === 429 ? { 'retry-after': '120' } : {} }));
    try {
      await f.saveKey();
      const limited = await f.chat();
      expect(limited.statusCode).toBe(429);
      expect(limited.headers['retry-after']).toBe('120');
      expect(limited.json().error.message).toContain('Kimi membership usage limit reached');
      expect((await f.providers()).connection.detail).toContain('limit reached until');
      status = 401;
      expect((await f.chat()).statusCode).toBe(503);
      status = 500;
      expect((await f.messages()).statusCode).toBe(502);
      const stats = (await f.usage()).json();
      expect(stats.byProvider.kimi.error).toBe(3);
      expect(stats.byProvider.claude?.ok ?? 0).toBe(0);
    } finally { await f.app.close(); }
  });

  it('serves the dashboard key panel with the paid-membership note', async () => {
    const f = await fixture();
    try {
      const html = (await f.app.inject({ method: 'GET', url: '/dashboard' })).body;
      for (const text of ['Paid Kimi membership key required', 'kimiKeyInput', '/v1/providers/kimi/credentials', '/kimi/v1/chat/completions']) expect(html).toContain(text);
    } finally { await f.app.close(); }
  });

  it('can be paused and its key removed', async () => {
    const f = await fixture();
    try {
      await f.saveKey();
      const before = f.calls.length;
      f.app.gateway.servingGate.setProviderEnabled('kimi', false);
      expect((await f.chat()).statusCode).toBe(503);
      expect(f.calls).toHaveLength(before);
      const removed = await f.app.inject({ method: 'DELETE', url: '/v1/providers/kimi/credentials', headers: { authorization: `Bearer ${TEST_API_KEY}` } });
      expect(removed.statusCode).toBe(200);
      expect((await f.providers()).connection.state).toBe('not_configured');
    } finally { await f.app.close(); }
  });
});
