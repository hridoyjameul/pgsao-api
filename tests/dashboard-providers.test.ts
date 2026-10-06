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

  it('shows ChatGPT sign-in when disconnected and a ready-only Responses URL and models when connected', async () => {
    const html = (await ctx.app.inject({ method: 'GET', url: '/dashboard' })).body;
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    const snippets = html.match(/<script id="snippets-data" type="application\/json">([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeDefined();
    const makeNode = (tag = 'div') => ({ tag, children: [] as any[], textContent: '', innerHTML: '', value: '', hidden: false, disabled: false, className: '', onclick: undefined as undefined | (() => void), appendChild(child: any) { this.children.push(child); }, replaceChildren() { this.children = []; } });
    const elements = new Map<string, any>();
    const element = (id: string) => {
      if (!elements.has(id)) elements.set(id, Object.assign(makeNode(), { textContent: id === 'snippets-data' ? snippets : '' }));
      return elements.get(id);
    };
    let connected = false;
    const calls: string[] = [];
    let navigated = '';
    const fetchFake = async (path: string, options?: { method?: string }) => {
      calls.push(path);
      const provider = { id: 'chatgpt', displayName: 'ChatGPT', client: { state: 'not_required', method: 'Direct account connection' },
        connection: connected ? { state: 'connected', detail: 'owner@example.test', registrations: [{ registrationId: 'one', label: 'owner@example.test', selected: true }] } : { state: 'not_configured', registrations: [] },
        api: connected ? { ready: true, capabilities: [{ shape: 'openai_responses', basePath: '/chatgpt/v1' }] } : { ready: false, capabilities: [] }, setupAction: 'sign_in' };
      const data = path === '/v1/providers' ? { providers: [provider] }
        : path === '/v1/providers/chatgpt/connect' ? { authorizationUrl: 'https://auth.openai.com/api/accounts/authorize?state=test' }
          : path === '/chatgpt/v1/models' ? { models: [{ slug: 'gpt-test', display_name: 'GPT Test' }] }
            : path === '/v1/control/serving' ? { enabled: true }
              : path === '/health' ? { claude_auth_status: 'ok' }
                : { total: 0, byRoute: {}, byProvider: {}, errorsByType: {} };
      return { ok: true, status: 200, json: async () => data };
    };
    const intervals: Array<() => void> = [];
    runInNewContext(script!, {
      document: { getElementById: element, createElement: makeNode, querySelectorAll: () => [], querySelector: () => null },
      localStorage: { getItem: () => TEST_API_KEY, setItem() {} }, fetch: fetchFake,
      setInterval: (callback: () => void) => { intervals.push(callback); }, setTimeout: () => 0,
      window: { location: { origin: ctx.baseUrl, assign: (url: string) => { navigated = url; } } }, navigator: {},
    });
    const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(setImmediate); };
    const walk = (node: any): any[] => [node, ...node.children.flatMap(walk)];
    await settle();
    let nodes = walk(element('providerCards'));
    expect(nodes.some((n) => n.value === ctx.baseUrl + '/chatgpt/v1')).toBe(false);
    const connect = nodes.find((n) => n.textContent === 'Continue with ChatGPT');
    expect(connect).toBeDefined();
    connect.onclick();
    await settle();
    expect(calls).toContain('/v1/providers/chatgpt/connect');
    expect(navigated).toContain('https://auth.openai.com/');
    connected = true;
    intervals.forEach((callback) => callback());
    await settle();
    nodes = walk(element('providerCards'));
    expect(nodes.some((n) => n.value === ctx.baseUrl + '/chatgpt/v1')).toBe(true);
    expect(nodes.some((n) => n.textContent.includes('GPT Test (gpt-test)'))).toBe(true);
    expect(nodes.some((n) => n.textContent.includes('owner@example.test'))).toBe(true);
    expect(calls).toContain('/chatgpt/v1/models');
    expect(JSON.stringify(nodes)).not.toContain('selected-secret');
  });
});
