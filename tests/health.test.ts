import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './support/test-server.js';

describe('GET /health', () => {
  let ctx: Awaited<ReturnType<typeof startTestApp>>;

  beforeAll(async () => {
    ctx = await startTestApp();
  });
  afterAll(async () => ctx.close());

  it('is unauthenticated and reports the PRD §12 shape', async () => {
    const res = await fetch(`${ctx.baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body).toMatchObject({
      status: 'ok',
      routes: { openai_compatible: 'enabled', anthropic_compatible: 'enabled' },
    });
    expect(typeof body.active_requests).toBe('number');
    expect(typeof body.queued_requests).toBe('number');
  });

  it('reflects credential status after a check', async () => {
    await ctx.app.gateway.credentialMonitor.checkNow();
    const res = await fetch(`${ctx.baseUrl}/health`);
    const body = await res.json() as any;
    expect(body.claude_auth_status).toBe('ok');
  });
});
