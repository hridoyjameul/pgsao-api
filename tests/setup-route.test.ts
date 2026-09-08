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

  it('trusts the Docker default bridge network range (172.16.0.0/12), not just literal 127.0.0.1', async () => {
    // Regression test: under docker-compose (this project's documented deployment
    // path), the container binds HOST=0.0.0.0 and every request's remoteAddress is
    // rewritten to the bridge gateway (e.g. 172.19.0.1) by Docker's port-forwarder —
    // a strict "== 127.0.0.1" check 403s that exact, real setup.
    const app = ctx.app;
    const response = await app.inject({
      method: 'GET',
      url: '/v1/setup/key',
      remoteAddress: '172.19.0.1',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().apiKey).toBe(TEST_API_KEY);
  });

  it('rejects a caller with a public-looking IP', async () => {
    const app = ctx.app;
    const response = await app.inject({
      method: 'GET',
      url: '/v1/setup/key',
      remoteAddress: '203.0.113.5',
    });
    expect(response.statusCode).toBe(403);
  });
});
