import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, TEST_API_KEY } from './support/test-server.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config/config.js';
import { FakeClaudeProvider } from './support/fake-claude-provider.js';

const auth = { authorization: `Bearer ${TEST_API_KEY}` };
const openaiPayload = { model: 'claude-via-gateway', messages: [{ role: 'user', content: 'Hi' }] };
const anthropicPayload = { ...openaiPayload, max_tokens: 32 };

describe('serving control', () => {
  let ctx: Awaited<ReturnType<typeof startTestApp>>;
  beforeAll(async () => { ctx = await startTestApp(); });
  afterAll(async () => ctx.close());

  it('authenticates control, validates body, and pauses only new inference', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/v1/control/serving' })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'GET', url: '/v1/control/serving', headers: auth })).json()).toEqual({ enabled: true });
    expect((await ctx.app.inject({ method: 'POST', url: '/v1/control/serving', headers: auth, payload: { enabled: 'false' } })).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: 'POST', url: '/v1/control/serving', headers: { ...auth, 'content-type': 'application/json' }, payload: '{broken-json' })).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: 'POST', url: '/v1/control/serving', headers: auth, payload: { enabled: false } })).json()).toEqual({ enabled: false });
    const paths = ['/v1/chat/completions', '/claude/v1/chat/completions', '/v1/messages', '/claude/v1/messages'];
    const stopped = await Promise.all(paths.map((url) => ctx.app.inject({ method: 'POST', url, headers: auth, payload: url.endsWith('messages') ? anthropicPayload : openaiPayload })));
    expect(stopped.map((r) => r.statusCode)).toEqual([503, 503, 503, 503]);
    expect(stopped[0].json().error.type).toBe('service_paused');
    expect(stopped[2].json()).toMatchObject({ type: 'error', error: { type: 'service_paused' } });
    const available = await Promise.all(['/dashboard', '/v1/models', '/v1/providers'].map((url) => ctx.app.inject({ method: 'GET', url, headers: auth })));
    expect(available.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    await ctx.app.inject({ method: 'POST', url: '/v1/control/serving', headers: auth, payload: { enabled: true } });
    expect((await ctx.app.inject({ method: 'POST', url: '/claude/v1/chat/completions', headers: auth, payload: openaiPayload })).statusCode).toBe(200);
  });

  it('lets an active stream finish after stopping new requests', async () => {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    class DelayedProvider extends FakeClaudeProvider {
      override async *streamMessage(request: Parameters<FakeClaudeProvider['streamMessage']>[0]) {
        started();
        await gate;
        yield* super.streamMessage(request);
      }
    }
    const config = loadConfig({ GATEWAY_API_KEY: TEST_API_KEY, LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv);
    const app = await buildApp({ config, claudeProvider: new DelayedProvider(), dbPath: ':memory:' });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    try {
      const streamPromise = fetch(`${baseUrl}/claude/v1/chat/completions`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ ...openaiPayload, stream: true }) });
      await entered;
      const stop = await app.inject({ method: 'POST', url: '/v1/control/serving', headers: auth, payload: { enabled: false } });
      expect(stop.json()).toEqual({ enabled: false });
      const rejected = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: auth, payload: openaiPayload });
      expect(rejected.statusCode).toBe(503);
      release();
      expect((await (await streamPromise).text()).trim().endsWith('data: [DONE]')).toBe(true);
    } finally { release(); await app.close(); }
  });
});
