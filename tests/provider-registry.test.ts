import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectExecutable } from '../src/providers/detect-client.js';
import { startTestApp, TEST_API_KEY } from './support/test-server.js';

describe('provider status', () => {
  let ctx: Awaited<ReturnType<typeof startTestApp>>;
  beforeAll(async () => { ctx = await startTestApp(); });
  afterAll(async () => ctx.close());

  it('requires the local gateway key and describes only available routes', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/v1/providers' })).statusCode).toBe(401);
    const response = await ctx.app.inject({ method: 'GET', url: '/v1/providers', headers: { authorization: `Bearer ${TEST_API_KEY}` } });
    expect(response.statusCode).toBe(200);
    const providers = response.json().providers;
    expect(providers.map((p: { id: string }) => p.id)).toEqual(['claude', 'chatgpt', 'gemini', 'kimi', 'qwen']);
    expect(providers[0].api.ready).toBe(true);
    expect(providers.slice(1).every((p: { api: { ready: boolean; capabilities: unknown[] } }) => !p.api.ready && p.api.capabilities.length === 0)).toBe(true);
    expect(JSON.stringify(providers)).not.toContain(TEST_API_KEY);
  });

  it('does not advertise a disabled Claude API shape', async () => {
    const disabled = await startTestApp({ ENABLE_ANTHROPIC_COMPAT_ROUTE: 'false' });
    try {
      const response = await disabled.app.inject({ method: 'GET', url: '/v1/providers', headers: { authorization: `Bearer ${TEST_API_KEY}` } });
      const claude = response.json().providers[0];
      expect(claude.api.capabilities.some((c: { shape: string }) => c.shape === 'anthropic_messages')).toBe(false);
    } finally { await disabled.close(); }
  });

  it('explains when both implemented Claude shapes are disabled', async () => {
    const disabled = await startTestApp({ ENABLE_ANTHROPIC_COMPAT_ROUTE: 'false', ENABLE_OPENAI_COMPAT_ROUTE: 'false' });
    try {
      const response = await disabled.app.inject({ method: 'GET', url: '/v1/providers', headers: { authorization: `Bearer ${TEST_API_KEY}` } });
      const claude = response.json().providers[0];
      expect(claude.api.ready).toBe(false);
      expect(claude.setupAction).toBe('enable_route');
    } finally { await disabled.close(); }
  });
});

describe('non-executing CLI detection', () => {
  it('finds Windows .exe and .cmd shims and reports missing clients', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pgsao-cli-'));
    try {
      writeFileSync(join(dir, 'gemini.cmd'), 'do not run this');
      expect(detectExecutable('gemini', { pathEnv: dir, pathext: '.EXE;.CMD', platform: 'win32' })).toBe(true);
      expect(detectExecutable('qwen', { pathEnv: dir, pathext: '.EXE;.CMD', platform: 'win32' })).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
