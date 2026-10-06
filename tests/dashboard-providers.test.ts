import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Window } from 'happy-dom';
import { startTestApp, TEST_API_KEY } from './support/test-server.js';

type Json = Record<string, unknown>;
const KEYS: Record<string, string> = { claude: 'sk-pgsao-claude-aaa', chatgpt: 'sk-pgsao-chatgpt-bbb', gemini: 'sk-pgsao-gemini-ccc' };

function providerList(chatgptConnected: boolean, serving: Record<string, boolean> = {}): Json[] {
  const base = { client: { state: 'not_required', method: 'x' } };
  return [
    { ...base, id: 'claude', displayName: 'Claude', serving: serving.claude ?? true, connection: { state: 'connected', detail: 'Claude Pro' }, setupAction: 'none',
      api: { ready: true, capabilities: [{ shape: 'openai_chat', basePath: '/v1', legacy: true }, { shape: 'anthropic_messages', basePath: '/', legacy: true }, { shape: 'openai_chat', basePath: '/claude/v1' }, { shape: 'anthropic_messages', basePath: '/claude' }] } },
    { ...base, id: 'chatgpt', displayName: 'ChatGPT', serving: serving.chatgpt ?? true,
      connection: chatgptConnected ? { state: 'connected', detail: 'owner@example.test', registrations: [{ registrationId: 'one', label: 'owner@example.test', selected: true }] } : { state: 'not_configured', registrations: [] },
      setupAction: chatgptConnected ? 'none' : 'sign_in',
      api: chatgptConnected ? { ready: true, capabilities: [{ shape: 'openai_responses', basePath: '/chatgpt/v1' }] } : { ready: false, capabilities: [] } },
    ...['gemini', 'kimi', 'qwen'].map((id) => ({ ...base, id, displayName: id[0]!.toUpperCase() + id.slice(1), serving: true, connection: { state: 'not_configured' }, setupAction: 'coming_soon', api: { ready: false, capabilities: [] } })),
  ];
}

async function openDashboard(ctx: { app: { inject: (o: object) => Promise<{ body: string }> }; baseUrl: string }, opts: { chatgptConnected?: boolean } = {}) {
  const html = (await ctx.app.inject({ method: 'GET', url: '/dashboard' })).body;
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]!;
  const snippets = html.match(/<script id="snippets-data" type="application\/json">([\s\S]*?)<\/script>/)?.[1]!;
  const win = new Window({ url: ctx.baseUrl + '/dashboard' });
  win.document.write(html.replace(/<script>[\s\S]*?<\/script>/, ''));
  const calls: Array<{ path: string; method: string; body?: string }> = [];
  const state = { chatgptConnected: opts.chatgptConnected ?? true, serving: {} as Record<string, boolean>, rotated: 0 };
  const navigated: string[] = [];
  const intervals: Array<() => void> = [];
  (win as unknown as { fetch: unknown }).fetch = async (path: string, init: { method?: string; body?: string } = {}) => {
    calls.push({ path, method: init.method ?? 'GET', body: init.body });
    const route = path.split('?')[0]!;
    let data: unknown = {};
    let status = 200;
    const m = route.match(/^\/v1\/providers\/(\w+)\/(key|serving|key\/rotate)$/);
    if (route === '/v1/providers') data = { providers: providerList(state.chatgptConnected, state.serving) };
    else if (m && m[2] === 'key') data = { apiKey: KEYS[m[1]!] ?? 'sk-x' };
    else if (m && m[2] === 'key/rotate') data = { apiKey: `rotated-${m[1]}-${++state.rotated}` };
    else if (m && m[2] === 'serving') { state.serving[m[1]!] = JSON.parse(init.body!).enabled; data = { enabled: state.serving[m[1]!] }; }
    else if (route === '/v1/usage') data = path.includes('provider=chatgpt')
      ? { total: 7, byRoute: { responses: { total: 7, ok: 6, error: 1, avgQueueWaitMs: 12 } }, byProvider: { chatgpt: { total: 7, ok: 6, error: 1, avgQueueWaitMs: 12 } }, errorsByType: { usage_limit_error: 1 } }
      : { total: 119, byRoute: { openai: { total: 119, ok: 118, error: 1, avgQueueWaitMs: 910 } }, byProvider: { claude: { total: 119, ok: 118, error: 1, avgQueueWaitMs: 910 } }, errorsByType: { authentication_error: 1 } };
    else if (route === '/claude/v1/models') data = { data: [{ id: 'claude-via-gateway' }] };
    else if (route === '/chatgpt/v1/models') data = { models: [{ slug: 'gpt-test', display_name: 'GPT Test' }] };
    else if (route === '/health') data = { claude_auth_status: 'ok' };
    else if (route === '/v1/providers/chatgpt/connect') data = { authorizationUrl: 'https://auth.openai.com/api/accounts/authorize?state=t' };
    else if (route === '/v1/providers/chatgpt/disconnect') data = { remoteRevocationConfirmed: true };
    else if (route.startsWith('/v1/sessions')) data = { id: 'sess-1' };
    return { ok: status < 400, status, json: async () => data };
  };
  win.localStorage.setItem('pgsao_gateway_api_key', TEST_API_KEY);
  (win as unknown as { setInterval: unknown }).setInterval = (cb: () => void) => { intervals.push(cb); return 1; };
  (win as unknown as { location: { assign: (u: string) => void } }).location.assign = (u: string) => { navigated.push(u); };
  win.document.getElementById('snippets-data')!.textContent = snippets;
  win.eval(script);
  const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };
  await settle();
  const $ = (sel: string) => win.document.querySelector(sel) as unknown as HTMLElement | null;
  const text = (sel: string) => $(sel)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const click = async (sel: string) => { ($(sel) as unknown as { click(): void }).click(); await settle(); };
  return { win, calls, state, navigated, intervals, settle, $, text, click };
}

describe('provider-scoped dashboard', () => {
  let ctx: Awaited<ReturnType<typeof startTestApp>>;
  beforeAll(async () => { ctx = await startTestApp(); });
  afterAll(async () => ctx.close());

  it('serves a shell without secrets and with a tile row for the five providers', async () => {
    const html = (await ctx.app.inject({ method: 'GET', url: '/dashboard' })).body;
    expect(html).toContain('id="providerTiles"');
    expect(html).toContain('Available AI Providers');
    expect(html).not.toContain(TEST_API_KEY);
  });

  it('never inserts untrusted Host markup into HTML or snippets', async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const response = await ctx.app.inject({ method: 'GET', url: '/dashboard', headers: { host: hostile } });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(hostile);
    expect(response.body).not.toContain('&lt;img');
  });

  it('renders five tiles and shows everything below for Claude by default', async () => {
    const d = await openDashboard(ctx);
    const tiles = Array.from(d.win.document.querySelectorAll('.tile')).map((t) => (t as unknown as HTMLElement).getAttribute('data-provider'));
    expect(tiles).toEqual(['claude', 'chatgpt', 'gemini', 'kimi', 'qwen']);
    expect(d.text('#apiAccessTitle')).toBe('API Access (Claude)');
    expect((d.$('#baseUrl') as HTMLInputElement).value).toBe(ctx.baseUrl + '/claude/v1');
    expect((d.$('#apiKey') as HTMLInputElement).value).toBe(KEYS.claude);
    expect(d.text('#usageTitle')).toBe('Usage (Claude)');
    expect(d.text('#usageBody')).toContain('119');
    expect(d.$('#sessionsCard')?.hasAttribute('hidden')).toBe(false);
    expect(d.text('#snippet')).toContain('/claude/v1/chat/completions');
    expect(d.calls.some((c) => c.path === '/v1/usage?provider=claude')).toBe(true);
  });

  it('switches key, URLs, usage, snippets and advanced settings when another provider is clicked', async () => {
    const d = await openDashboard(ctx);
    await d.click('.tile[data-provider="chatgpt"]');
    expect(d.text('#apiAccessTitle')).toBe('API Access (ChatGPT)');
    expect((d.$('#baseUrl') as HTMLInputElement).value).toBe(ctx.baseUrl + '/chatgpt/v1');
    expect((d.$('#apiKey') as HTMLInputElement).value).toBe(KEYS.chatgpt);
    expect(d.text('#usageTitle')).toBe('Usage (ChatGPT)');
    expect(d.text('#usageBody')).toContain('usage_limit_error');
    expect(d.text('#usageBody')).not.toContain('authentication_error');
    expect(d.$('#sessionsCard')?.hasAttribute('hidden')).toBe(true);
    expect(d.text('#snippet')).toContain('/chatgpt/v1/responses');
    expect(d.text('#snippet')).not.toContain('chat/completions');
    expect(d.text('#advancedTitle')).toBe('Advanced (ChatGPT)');
    expect(d.text('#advancedBody')).toContain('owner@example.test');
    expect(d.text('#advancedBody')).toContain('Disconnect ChatGPT');
    expect(d.text('#advancedBody')).toContain('gpt-test');
    await d.click('.tile[data-provider="claude"]');
    expect(d.text('#advancedTitle')).toBe('Advanced (Claude)');
    expect(d.text('#advancedBody')).not.toContain('Disconnect ChatGPT');
    expect(d.text('#advancedBody')).toContain('claude-via-gateway');
    expect((d.$('#apiKey') as HTMLInputElement).value).toBe(KEYS.claude);
  });

  it('lets each provider copy a different Base URL tab and hides legacy URLs from the main tabs', async () => {
    const d = await openDashboard(ctx);
    expect(Array.from(d.win.document.querySelectorAll('#urlTabs button')).map((b) => b.textContent)).toEqual(['OpenAI-style apps', 'Anthropic/Claude-style apps']);
    await d.click('#urlTabs button[data-shape="anthropic_messages"]');
    expect((d.$('#baseUrl') as HTMLInputElement).value).toBe(ctx.baseUrl + '/claude');
    expect(d.text('#advancedBody')).toContain(ctx.baseUrl + '/v1');
  });

  it('starts and stops one provider from its tile', async () => {
    const d = await openDashboard(ctx);
    expect(d.text('.tile[data-provider="claude"] .tile-action')).toBe('Stop');
    await d.click('.tile[data-provider="claude"] .tile-action');
    expect(d.calls).toContainEqual({ path: '/v1/providers/claude/serving', method: 'POST', body: JSON.stringify({ enabled: false }) });
    d.intervals.forEach((cb) => cb()); await d.settle();
    expect(d.text('.tile[data-provider="claude"] .tile-action')).toBe('Start');
    expect(d.text('.tile[data-provider="chatgpt"] .tile-action')).toBe('Stop');
  });

  it('regenerates only the selected provider key', async () => {
    const d = await openDashboard(ctx);
    await d.click('#rotateKey');
    expect(d.calls).toContainEqual({ path: '/v1/providers/claude/key/rotate', method: 'POST', body: undefined });
    expect((d.$('#apiKey') as HTMLInputElement).value).toBe('rotated-claude-1');
    await d.click('.tile[data-provider="chatgpt"]');
    expect((d.$('#apiKey') as HTMLInputElement).value).toBe(KEYS.chatgpt);
  });

  it('offers Connect for a disconnected ChatGPT and shows no key or URL until connected', async () => {
    const d = await openDashboard(ctx, { chatgptConnected: false });
    expect(d.text('.tile[data-provider="chatgpt"] .tile-action')).toBe('Connect');
    await d.click('.tile[data-provider="chatgpt"] .tile-action');
    expect(d.calls.some((c) => c.path === '/v1/providers/chatgpt/connect' && c.method === 'POST')).toBe(true);
    expect(d.navigated[0]).toContain('https://auth.openai.com/');
    expect(d.$('#baseUrl')).toBeNull();
    expect(d.$('#apiKey')).toBeNull();
  });

  it('marks unavailable providers coming soon without key or URL', async () => {
    const d = await openDashboard(ctx);
    expect(d.text('.tile[data-provider="gemini"] .tile-action')).toBe('Coming soon');
    expect(d.$('.tile[data-provider="gemini"] .tile-action')?.hasAttribute('disabled')).toBe(true);
    await d.click('.tile[data-provider="gemini"]');
    expect(d.text('#apiAccessTitle')).toBe('API Access (Gemini)');
    expect(d.text('#apiAccess')).toContain('Coming soon');
    expect(d.$('#baseUrl')).toBeNull();
    expect(d.text('#advancedTitle')).toBe('Advanced (Gemini)');
    expect(d.calls.some((c) => c.path === '/v1/providers/gemini/key')).toBe(false);
  });

  it('keeps refreshing provider status while open', async () => {
    const d = await openDashboard(ctx);
    const before = d.calls.filter((c) => c.path === '/v1/providers').length;
    d.intervals.forEach((cb) => cb()); await d.settle();
    expect(d.calls.filter((c) => c.path === '/v1/providers').length).toBeGreaterThan(before);
  });
});
