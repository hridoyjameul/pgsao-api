import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, TEST_API_KEY } from './support/test-server.js';

describe('GET /v1/usage (PRD §22 P2.4/§28 Phase 4)', () => {
  let ctx: Awaited<ReturnType<typeof startTestApp>>;

  beforeAll(async () => {
    ctx = await startTestApp();
  });
  afterAll(async () => ctx.close());

  it('requires auth', async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/usage`);
    expect(res.status).toBe(401);
  });

  it('splits request counts by route', async () => {
    await fetch(`${ctx.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TEST_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-via-gateway', messages: [{ role: 'user', content: 'Hi' }] }),
    });
    await fetch(`${ctx.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': TEST_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-via-gateway', max_tokens: 16, messages: [{ role: 'user', content: 'Hi' }] }),
    });

    const res = await fetch(`${ctx.baseUrl}/v1/usage`, { headers: { authorization: `Bearer ${TEST_API_KEY}` } });
    const body = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(body.byRoute.openai.total).toBeGreaterThanOrEqual(1);
    expect(body.byRoute.anthropic.total).toBeGreaterThanOrEqual(1);
    expect(body.total).toBeGreaterThanOrEqual(2);
  });
});
