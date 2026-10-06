import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, TEST_API_KEY } from './support/test-server.js';

describe('five-provider dashboard', () => {
  let ctx: Awaited<ReturnType<typeof startTestApp>>;
  beforeAll(async () => { ctx = await startTestApp(); });
  afterAll(async () => ctx.close());

  it('has provider, serving, and usage panels backed by authenticated routes', async () => {
    const html = (await ctx.app.inject({ method: 'GET', url: '/dashboard' })).body;
    expect(html).toContain('id="providerCards"');
    expect(html).toContain('Client detected');
    expect(html).toContain('Account connected');
    expect(html).toContain('Gateway API ready');
    expect(html).toContain('/v1/control/serving');
    expect(html).toContain('byProvider');
    expect(html).not.toContain(TEST_API_KEY);
    const status = await ctx.app.inject({ method: 'GET', url: '/v1/providers', headers: { 'x-api-key': TEST_API_KEY } });
    expect(status.json().providers.map((p: { displayName: string }) => p.displayName)).toEqual(['Claude', 'ChatGPT', 'Gemini', 'Kimi', 'Qwen']);
    expect(status.json().providers.filter((p: { api: { ready: boolean } }) => p.api.ready).map((p: { id: string }) => p.id)).toEqual(['claude']);
  });

  it('never inserts untrusted Host markup into HTML or snippets', async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const response = await ctx.app.inject({ method: 'GET', url: '/dashboard', headers: { host: hostile } });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(hostile);
    expect(response.body).not.toContain('&lt;img');
  });
});
