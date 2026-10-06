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
const body = { model: 'gpt-test', input: [{ role: 'user', content: 'Hello' }], store: false, stream: true };
const successSse = 'event: response.created\ndata: {"type":"response.created"}\n\nevent: response.completed\ndata: {"type":"response.completed"}\n\ndata: [DONE]\n\n';
async function fixture(sse: string | string[] = successSse, connected = true, upstreamStatus = 200) {
  const root = await mkdtemp(join(tmpdir(), 'pgsao-responses-'));
  dirs.push(root);
  const store = new ChatGptCredentialStore(join(root, 'private', 'chatgpt.json'));
  if (connected) await store.save({ hostId: 'urn:uuid:5c3cb76b-3e1c-4d4c-9d14-87eb1839dc22', selectedRegistrationId: 'one', accounts: [{ registrationId: 'one', clientId: 'oaiapp_one', issuer: 'https://auth.openai.com', subject: 'sub', scopes: ['chatgpt.tokens.use.direct'], accessToken: 'selected-secret', refreshToken: 'refresh-secret', idToken: 'id-secret', expiresAt: Date.now() + 3600_000 }] });
  const calls: Array<{ url: string; auth: string | null; body: string | undefined }> = [];
  const http: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(input), auth: headers.get('authorization'), body: String(init?.body) });
    const stream = Array.isArray(sse) ? new ReadableStream({ start(controller) { const encoder = new TextEncoder(); for (const chunk of sse) controller.enqueue(encoder.encode(chunk)); controller.close(); } }) : sse;
    return new Response(stream, { status: upstreamStatus, headers: { 'content-type': 'text/event-stream' } });
  };
  const config = loadConfig({ GATEWAY_API_KEY: TEST_API_KEY, LOG_LEVEL: 'silent', CHATGPT_CREDENTIALS_PATH: store.path } as NodeJS.ProcessEnv);
  const claudeProvider = new FakeClaudeProvider();
  const app = await buildApp({ config, claudeProvider, dbPath: ':memory:', chatGptFetch: http });
  const post = (payload: unknown = body, key = TEST_API_KEY) => app.inject({ method: 'POST', url: '/chatgpt/v1/responses', headers: { authorization: `Bearer ${key}` }, payload });
  const usage = () => app.inject({ method: 'GET', url: '/v1/usage', headers: { 'x-api-key': TEST_API_KEY } });
  return { app, calls, claudeProvider, post, usage };
}

describe('ChatGPT Responses SSE', () => {
  it('requires auth and the exact text-only request subset before upstream', async () => {
    const f = await fixture();
    try {
      expect((await f.post(body, 'wrong')).statusCode).toBe(401);
      for (const payload of [{ ...body, store: true }, { ...body, stream: false }, { ...body, previous_response_id: 'x' }, { ...body, tools: [] }, { ...body, input: [{ role: 'system', content: 'no' }] }]) {
        expect((await f.post(payload)).statusCode).toBe(400);
      }
      expect(f.calls).toHaveLength(0);
    } finally { await f.app.close(); }
  });

  it('uses the fixed URL and selected token, forwards completion, and audits ChatGPT', async () => {
    const f = await fixture();
    try {
      const response = await f.post();
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');
      expect(response.body).toContain('response.completed');
      expect(f.calls).toEqual([{ url: 'https://api.openai.com/v1/responses', auth: 'Bearer selected-secret', body: JSON.stringify(body) }]);
      const usage = (await f.usage()).json();
      expect(usage.byProvider.chatgpt.ok).toBe(1);
      expect(usage.byRoute.responses.ok).toBe(1);
      expect(f.claudeProvider.lastRequest).toBeUndefined();
    } finally { await f.app.close(); }
  });

  it('audits failed and incomplete streams without inventing completion', async () => {
    for (const event of ['response.failed', 'response.incomplete']) {
      const f = await fixture(`event: ${event}\ndata: {"type":"${event}"}\n\n`);
      try {
        const response = await f.post();
        expect(response.body).toContain(event);
        expect(response.body).not.toContain('response.completed');
        expect((await f.usage()).json().byProvider.chatgpt.error).toBe(1);
      } finally { await f.app.close(); }
    }
    const broken = await fixture('event: response.created\ndata: {"type":"response.created"}');
    try {
      expect((await broken.post()).body).not.toContain('response.completed');
      expect((await broken.usage()).json().byRoute.responses.error).toBe(1);
    } finally { await broken.app.close(); }
  });

  it('accepts CRLF frame separators split across transport chunks', async () => {
    const f = await fixture(['event: response.completed\r', '\ndata: {"type":"response.completed"}\r', '\n\r', '\n']);
    try {
      const response = await f.post();
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('response.completed');
      expect((await f.usage()).json().byRoute.responses.ok).toBe(1);
    } finally { await f.app.close(); }
  });

  it('rejects disconnected, paused and upstream-limit calls without Claude fallback', async () => {
    const disconnected = await fixture(successSse, false);
    try {
      expect((await disconnected.post()).statusCode).toBe(503);
      expect(disconnected.calls).toHaveLength(0);
    } finally { await disconnected.app.close(); }
    const paused = await fixture();
    try {
      paused.app.gateway.servingGate.setEnabled(false);
      expect((await paused.post()).statusCode).toBe(503);
      expect(paused.calls).toHaveLength(0);
    } finally { await paused.app.close(); }
    const limited = await fixture('usage limit', true, 429);
    try {
      expect((await limited.post()).statusCode).toBe(429);
      expect(limited.claudeProvider.lastRequest).toBeUndefined();
    } finally { await limited.app.close(); }
  });
});
