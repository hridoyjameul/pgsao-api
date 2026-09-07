import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './support/test-server.js';

describe('GET /dashboard', () => {
  let ctx: Awaited<ReturnType<typeof startTestApp>>;

  beforeAll(async () => {
    ctx = await startTestApp();
  });
  afterAll(async () => ctx.close());

  it('is unauthenticated and serves the control panel HTML', async () => {
    const res = await fetch(`${ctx.baseUrl}/dashboard`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('<title>PGSAO API</title>');
    expect(body).toContain('/v1/usage');
    expect(body).toContain('/v1/sessions');
  });

  it('embeds valid JSON snippet data with no unescaped </script> sequences', async () => {
    const res = await fetch(`${ctx.baseUrl}/dashboard`);
    const body = await res.text();
    const match = body.match(/<script id="snippets-data" type="application\/json">([\s\S]*?)<\/script>/);
    expect(match).not.toBeNull();
    const snippets = JSON.parse(match![1]!);
    expect(snippets['curl-openai']).toContain('/v1/chat/completions');
    expect(snippets['curl-anthropic']).toContain('/v1/messages');
    expect(snippets['sdk-openai']).toContain('OpenAI');
    expect(snippets['sdk-anthropic']).toContain('Anthropic');
  });
});
