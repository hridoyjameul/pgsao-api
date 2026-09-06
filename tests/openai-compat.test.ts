import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import OpenAI from 'openai';
import { startTestApp, TEST_API_KEY } from './support/test-server.js';

describe('POST /v1/chat/completions (OpenAI-compatible)', () => {
  let ctx: Awaited<ReturnType<typeof startTestApp>>;
  let client: OpenAI;

  beforeAll(async () => {
    ctx = await startTestApp();
    client = new OpenAI({ apiKey: TEST_API_KEY, baseURL: `${ctx.baseUrl}/v1` });
  });
  afterAll(async () => ctx.close());

  it('happy path — real openai client parses a successful response', async () => {
    const completion = await client.chat.completions.create({
      model: 'claude-via-gateway',
      messages: [{ role: 'user', content: 'Explain how Docker networking works.' }],
    });
    expect(completion.object).toBe('chat.completion');
    expect(completion.choices[0]?.message.role).toBe('assistant');
    expect(completion.choices[0]?.finish_reason).toBe('stop');
    expect(completion.usage?.total_tokens).toBeGreaterThan(0);
  });

  it('max_tokens optional — server accepts omission (contrast with Anthropic route)', async () => {
    const completion = await client.chat.completions.create({
      model: 'claude-via-gateway',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    expect(completion.choices[0]?.message.content).toBeTruthy();
  });

  it('tools present -> invalid_request_error (NG6 not yet supported)', async () => {
    await expect(
      client.chat.completions.create({
        model: 'claude-via-gateway',
        messages: [{ role: 'user', content: 'Hi' }],
        tools: [{ type: 'function', function: { name: 'noop', parameters: {} } }],
      } as any)
    ).rejects.toMatchObject({ status: 400 });
  });

  it('auth via Authorization: Bearer succeeds (this route\'s "natural" header)', async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TEST_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-via-gateway', messages: [{ role: 'user', content: 'Hi' }] }),
    });
    expect(res.status).toBe(200);
  });

  it('auth via x-api-key also succeeds (dual-header support, PRD §6.4)', async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'x-api-key': TEST_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-via-gateway', messages: [{ role: 'user', content: 'Hi' }] }),
    });
    expect(res.status).toBe(200);
  });

  it('bad auth -> 401, no top-level wrapper (the reverse of the Anthropic shape)', async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-key', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-via-gateway', messages: [{ role: 'user', content: 'Hi' }] }),
    });
    expect(res.status).toBe(401);
    const body = await res.json() as any;
    expect(body).toMatchObject({ error: { type: 'invalid_request_error', code: 'invalid_api_key' } });
    expect(body.type).toBeUndefined();
  });

  it('no session_id -> stateless fresh call each time (M14)', async () => {
    await client.chat.completions.create({ model: 'claude-via-gateway', messages: [{ role: 'user', content: 'Remember Y' }] });
    const b = await client.chat.completions.create({ model: 'claude-via-gateway', messages: [{ role: 'user', content: 'What did I ask you to remember?' }] });
    expect(b.choices[0]?.message.content).toContain('nothing');
  });

  it('streaming terminates with the literal [DONE] sentinel', async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TEST_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-via-gateway', stream: true, messages: [{ role: 'user', content: 'Hi' }] }),
    });
    const text = await res.text();
    expect(text.trim().endsWith('data: [DONE]')).toBe(true);
  });
});
