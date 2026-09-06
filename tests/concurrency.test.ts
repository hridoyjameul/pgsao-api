import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, TEST_API_KEY } from './support/test-server.js';

describe('concurrency queue (PRD §6.6)', () => {
  let ctx: Awaited<ReturnType<typeof startTestApp>>;

  beforeAll(async () => {
    ctx = await startTestApp({ MAX_CONCURRENT_REQUESTS: '1', QUEUE_MAX_SIZE: '1' });
    ctx.claudeProvider.delayMs = 300;
  });
  afterAll(async () => ctx.close());

  const send = () =>
    fetch(`${ctx.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TEST_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-via-gateway', messages: [{ role: 'user', content: 'Hi' }] }),
    });

  it('queue-full -> rate_limit_error in the caller\'s native (OpenAI) shape, distinct from usage_limit_error', async () => {
    // 1 active slot + 1 queued slot are allowed; a 3rd concurrent request must be rejected.
    const [r1, r2, r3] = await Promise.all([send(), send(), send()]);
    const statuses = [r1.status, r2.status, r3.status].sort();
    expect(statuses).toEqual([200, 200, 429]);

    const rejected = [r1, r2, r3].find((r) => r.status === 429)!;
    const body = (await rejected.json()) as any;
    expect(body.error.type).toBe('rate_limit_error');
  });
});
