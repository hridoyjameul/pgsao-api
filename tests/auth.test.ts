import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, TEST_API_KEY } from './support/test-server.js';

describe('dual-header auth on both routes (PRD §6.4)', () => {
  let ctx: Awaited<ReturnType<typeof startTestApp>>;

  beforeAll(async () => {
    ctx = await startTestApp();
  });
  afterAll(async () => ctx.close());

  const routes = [
    { path: '/v1/messages', body: { model: 'claude-via-gateway', max_tokens: 16, messages: [{ role: 'user', content: 'Hi' }] } },
    { path: '/v1/chat/completions', body: { model: 'claude-via-gateway', messages: [{ role: 'user', content: 'Hi' }] } },
  ];
  const headerVariants = [
    { name: 'Authorization: Bearer', headers: (key: string) => ({ authorization: `Bearer ${key}` }) },
    { name: 'x-api-key', headers: (key: string) => ({ 'x-api-key': key }) },
  ];

  for (const route of routes) {
    for (const variant of headerVariants) {
      it(`${route.path} accepts ${variant.name} (not just its "natural" header)`, async () => {
        const res = await fetch(`${ctx.baseUrl}${route.path}`, {
          method: 'POST',
          headers: { ...variant.headers(TEST_API_KEY), 'content-type': 'application/json' },
          body: JSON.stringify(route.body),
        });
        expect(res.status).toBe(200);
      });
    }

    it(`${route.path} rejects when neither header carries a valid key`, async () => {
      const res = await fetch(`${ctx.baseUrl}${route.path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(route.body),
      });
      expect(res.status).toBe(401);
    });
  }

  it('anthropic-version header is accepted and ignored, not rejected', async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': TEST_API_KEY, 'anthropic-version': '2099-01-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-via-gateway', max_tokens: 16, messages: [{ role: 'user', content: 'Hi' }] }),
    });
    expect(res.status).toBe(200);
  });
});
