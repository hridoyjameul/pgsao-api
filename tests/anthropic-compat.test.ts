import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { startTestApp, TEST_API_KEY } from './support/test-server.js';

describe('POST /v1/messages (Anthropic-compatible)', () => {
  let ctx: Awaited<ReturnType<typeof startTestApp>>;
  let client: Anthropic;

  beforeAll(async () => {
    ctx = await startTestApp();
    client = new Anthropic({ apiKey: TEST_API_KEY, baseURL: ctx.baseUrl });
  });
  afterAll(async () => ctx.close());

  it('happy path — real @anthropic-ai/sdk client parses a successful response', async () => {
    const message = await client.messages.create({
      model: 'claude-via-gateway',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'Explain how Docker networking works.' }],
    });
    expect(message.role).toBe('assistant');
    expect(message.content[0]).toMatchObject({ type: 'text' });
    expect(message.stop_reason).toBe('end_turn');
    expect(message.usage.input_tokens).toBeGreaterThan(0);
  });

  it('missing max_tokens -> invalid_request_error', async () => {
    await expect(
      client.messages.create({
        model: 'claude-via-gateway',
        messages: [{ role: 'user', content: 'Hi' }],
      } as any)
    ).rejects.toMatchObject({ status: 400 });
  });

  // Tool-calling itself is exercised in tests/tool-calling.test.ts (Phase 3/NG6).

  it('auth via x-api-key succeeds (the route\'s "natural" header)', async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': TEST_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-via-gateway', max_tokens: 16, messages: [{ role: 'user', content: 'Hi' }] }),
    });
    expect(res.status).toBe(200);
  });

  it('auth via Authorization: Bearer also succeeds (dual-header support, PRD §6.4)', async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TEST_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-via-gateway', max_tokens: 16, messages: [{ role: 'user', content: 'Hi' }] }),
    });
    expect(res.status).toBe(200);
  });

  it('bad auth -> 401 rendered with the required top-level "type":"error" wrapper', async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': 'wrong-key', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-via-gateway', max_tokens: 16, messages: [{ role: 'user', content: 'Hi' }] }),
    });
    expect(res.status).toBe(401);
    const body = await res.json() as any;
    expect(body).toMatchObject({ type: 'error', error: { type: 'authentication_error' } });
  });

  it('no session_id -> stateless fresh call each time (M14)', async () => {
    const a = await client.messages.create({ model: 'claude-via-gateway', max_tokens: 32, messages: [{ role: 'user', content: 'Remember X' }] });
    const b = await client.messages.create({ model: 'claude-via-gateway', max_tokens: 32, messages: [{ role: 'user', content: 'What did I ask you to remember?' }] });
    // Different underlying fake sessions -> the second call has no memory of the first.
    expect(b.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('nothing') });
    expect(a.content).toBeDefined();
  });

  it('session_id present -> explicit resume, same session recalls prior turn', async () => {
    const sessionId = `sess-${Date.now()}`;
    await fetch(`${ctx.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': TEST_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-via-gateway', max_tokens: 32, session_id: sessionId, messages: [{ role: 'user', content: 'Remember the word PELICAN' }] }),
    });
    const res2 = await fetch(`${ctx.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': TEST_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-via-gateway', max_tokens: 32, session_id: sessionId, messages: [{ role: 'user', content: 'What did I ask you to remember?' }] }),
    });
    const body2 = await res2.json() as any;
    expect(body2.content[0].text).toContain('PELICAN');
  });
});
