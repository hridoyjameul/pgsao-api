import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, TEST_API_KEY } from './support/test-server.js';
import { runInNewContext } from 'node:vm';

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

  it('refreshes provider and serving data while the page remains open', async () => {
    const html = (await ctx.app.inject({ method: 'GET', url: '/dashboard' })).body;
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    const snippets = html.match(/<script id="snippets-data" type="application\/json">([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeDefined();
    expect(snippets).toBeDefined();
    const elements = new Map<string, any>();
    const element = (id: string) => {
      if (!elements.has(id)) elements.set(id, { textContent: id === 'snippets-data' ? snippets : '', innerHTML: '', value: '', hidden: false, disabled: false, replaceChildren() {}, appendChild() {} });
      return elements.get(id);
    };
    const calls: string[] = [];
    const intervals: Array<() => void> = [];
    const fetchFake = async (path: string) => {
      calls.push(path);
      const body = path === '/v1/providers' ? { providers: [] }
        : path === '/v1/control/serving' ? { enabled: true }
          : path === '/health' ? { claude_auth_status: 'ok' }
            : { total: 0, byRoute: {}, byProvider: {}, errorsByType: {} };
      return { ok: true, json: async () => body };
    };
    runInNewContext(script!, {
      document: { getElementById: element, querySelectorAll: () => [], querySelector: () => null },
      localStorage: { getItem: () => TEST_API_KEY, setItem() {} },
      fetch: fetchFake,
      setInterval: (callback: () => void) => { intervals.push(callback); },
      window: { location: { origin: ctx.baseUrl } },
      navigator: {},
    });
    await new Promise(setImmediate);
    const providersBefore = calls.filter((path) => path === '/v1/providers').length;
    const servingBefore = calls.filter((path) => path === '/v1/control/serving').length;
    for (const callback of intervals) callback();
    await new Promise(setImmediate);
    expect(calls.filter((path) => path === '/v1/providers').length).toBeGreaterThan(providersBefore);
    expect(calls.filter((path) => path === '/v1/control/serving').length).toBeGreaterThan(servingBefore);
  });
});
