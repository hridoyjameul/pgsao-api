import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import { startTestApp, TEST_API_KEY } from './support/test-server.js';

describe('GET /v1/setup/key', () => {
  let ctx: Awaited<ReturnType<typeof startTestApp>>;

  beforeAll(async () => {
    ctx = await startTestApp();
  });
  afterAll(async () => ctx.close());

  it('is unauthenticated and returns the real gateway key when called from loopback', async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/setup/key`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { apiKey: string };
    expect(body.apiKey).toBe(TEST_API_KEY);
  });
});
