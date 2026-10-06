import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestApp, TEST_API_KEY } from './support/test-server.js';
import { ProviderKeyStore } from '../src/auth/provider-keys.js';

const master = { authorization: `Bearer ${TEST_API_KEY}` };
const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
const chat = { model: 'claude-via-gateway', messages: [{ role: 'user', content: 'Hi' }] };
const responses = { model: 'gpt-test', input: [{ role: 'user', content: 'Hi' }], store: false, stream: true };

describe('per-provider API keys', () => {
  let ctx: Awaited<ReturnType<typeof startTestApp>>;
  beforeAll(async () => { ctx = await startTestApp(); });
  afterAll(async () => ctx.close());
  const keyOf = async (id: string) => (await ctx.app.inject({ method: 'GET', url: `/v1/providers/${id}/key`, headers: master })).json().apiKey as string;

  it('gives each provider its own distinct key, readable only with the master key', async () => {
    const claude = await keyOf('claude');
    const chatgpt = await keyOf('chatgpt');
    expect(claude).toMatch(/^sk-pgsao-claude-/);
    expect(chatgpt).toMatch(/^sk-pgsao-chatgpt-/);
    expect(claude).not.toBe(chatgpt);
    expect(claude).not.toBe(TEST_API_KEY);
    expect((await ctx.app.inject({ method: 'GET', url: '/v1/providers/claude/key' })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'GET', url: '/v1/providers/claude/key', headers: bearer(claude) })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'GET', url: '/v1/providers/nope/key', headers: master })).statusCode).toBe(404);
  });

  it('accepts a provider key only on that provider\'s routes (master key works everywhere)', async () => {
    const claude = await keyOf('claude');
    const chatgpt = await keyOf('chatgpt');
    for (const url of ['/v1/chat/completions', '/claude/v1/chat/completions']) {
      expect((await ctx.app.inject({ method: 'POST', url, headers: bearer(claude), payload: chat })).statusCode).toBe(200);
      expect((await ctx.app.inject({ method: 'POST', url, headers: bearer(chatgpt), payload: chat })).statusCode).toBe(401);
    }
    expect((await ctx.app.inject({ method: 'GET', url: '/claude/v1/models', headers: bearer(chatgpt) })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'GET', url: '/claude/v1/models', headers: { 'x-api-key': claude } })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'POST', url: '/chatgpt/v1/responses', headers: bearer(claude), payload: responses })).statusCode).toBe(401);
    const own = await ctx.app.inject({ method: 'POST', url: '/chatgpt/v1/responses', headers: bearer(chatgpt), payload: responses });
    expect(own.statusCode).not.toBe(401);
    expect((await ctx.app.inject({ method: 'GET', url: '/chatgpt/v1/models', headers: bearer(claude) })).statusCode).toBe(401);
    // Admin routes stay master-only.
    expect((await ctx.app.inject({ method: 'GET', url: '/v1/providers', headers: bearer(claude) })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'GET', url: '/v1/usage', headers: bearer(chatgpt) })).statusCode).toBe(401);
  });

  it('rotates one provider key without touching the others', async () => {
    const oldClaude = await keyOf('claude');
    const chatgpt = await keyOf('chatgpt');
    const rotated = await ctx.app.inject({ method: 'POST', url: '/v1/providers/claude/key/rotate', headers: master });
    const fresh = rotated.json().apiKey as string;
    expect(fresh).not.toBe(oldClaude);
    expect(await keyOf('claude')).toBe(fresh);
    expect(await keyOf('chatgpt')).toBe(chatgpt);
    expect((await ctx.app.inject({ method: 'POST', url: '/v1/chat/completions', headers: bearer(oldClaude), payload: chat })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'POST', url: '/v1/chat/completions', headers: bearer(fresh), payload: chat })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'POST', url: '/v1/providers/claude/key/rotate', headers: bearer(fresh) })).statusCode).toBe(401);
  });

  it('pauses and resumes one provider without affecting the others', async () => {
    const off = await ctx.app.inject({ method: 'POST', url: '/v1/providers/chatgpt/serving', headers: master, payload: { enabled: false } });
    expect(off.json()).toEqual({ enabled: false });
    expect((await ctx.app.inject({ method: 'POST', url: '/chatgpt/v1/responses', headers: master, payload: responses })).json().error.type).toBe('service_paused');
    expect((await ctx.app.inject({ method: 'POST', url: '/v1/chat/completions', headers: master, payload: chat })).statusCode).toBe(200);
    const status = (await ctx.app.inject({ method: 'GET', url: '/v1/providers', headers: master })).json().providers;
    expect(status.map((p: { id: string; serving: boolean }) => [p.id, p.serving])).toEqual([['claude', true], ['chatgpt', false], ['gemini', true], ['kimi', true], ['qwen', true]]);
    await ctx.app.inject({ method: 'POST', url: '/v1/providers/claude/serving', headers: master, payload: { enabled: false } });
    expect((await ctx.app.inject({ method: 'POST', url: '/v1/chat/completions', headers: master, payload: chat })).json().error.type).toBe('service_paused');
    expect((await ctx.app.inject({ method: 'GET', url: '/v1/providers/claude/serving', headers: master })).json()).toEqual({ enabled: false });
    expect((await ctx.app.inject({ method: 'POST', url: '/v1/providers/claude/serving', headers: master, payload: { enabled: 'no' } })).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: 'POST', url: '/v1/providers/nope/serving', headers: master, payload: { enabled: true } })).statusCode).toBe(404);
    for (const id of ['claude', 'chatgpt']) await ctx.app.inject({ method: 'POST', url: `/v1/providers/${id}/serving`, headers: master, payload: { enabled: true } });
  });

  it('filters usage by provider', async () => {
    const all = (await ctx.app.inject({ method: 'GET', url: '/v1/usage', headers: master })).json();
    const claudeOnly = (await ctx.app.inject({ method: 'GET', url: '/v1/usage?provider=claude', headers: master })).json();
    const chatgptOnly = (await ctx.app.inject({ method: 'GET', url: '/v1/usage?provider=chatgpt', headers: master })).json();
    expect(claudeOnly.total).toBeGreaterThan(0);
    expect(Object.keys(claudeOnly.byProvider)).toEqual(['claude']);
    expect(chatgptOnly.total).toBe(chatgptOnly.byProvider.chatgpt?.total ?? 0);
    expect(claudeOnly.total + chatgptOnly.total).toBeLessThanOrEqual(all.total);
    expect((await ctx.app.inject({ method: 'GET', url: '/v1/usage?provider=nope', headers: master })).statusCode).toBe(400);
  });
});

describe('ProviderKeyStore', () => {
  it('persists generated keys privately across reloads and rotation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pgsao-keys-'));
    try {
      const path = join(dir, 'provider-keys.json');
      const first = new ProviderKeyStore(path);
      const claude = first.get('claude');
      expect(new ProviderKeyStore(path).get('claude')).toBe(claude);
      const rotated = first.rotate('claude');
      expect(rotated).not.toBe(claude);
      expect(new ProviderKeyStore(path).get('claude')).toBe(rotated);
      expect(first.matches('claude', rotated)).toBe(true);
      expect(first.matches('claude', claude)).toBe(false);
      expect(first.matches('chatgpt', rotated)).toBe(false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
