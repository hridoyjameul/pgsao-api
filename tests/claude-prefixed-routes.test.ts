import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { startTestApp, TEST_API_KEY } from './support/test-server.js';

describe('Claude provider-prefixed routes', () => {
  let ctx: Awaited<ReturnType<typeof startTestApp>>;
  beforeAll(async () => { ctx = await startTestApp(); });
  afterAll(async () => ctx.close());

  it('accepts real OpenAI and Anthropic SDK clients', async () => {
    const openai = new OpenAI({ apiKey: TEST_API_KEY, baseURL: `${ctx.baseUrl}/claude/v1` });
    const anthropic = new Anthropic({ apiKey: TEST_API_KEY, baseURL: `${ctx.baseUrl}/claude` });
    const completion = await openai.chat.completions.create({ model: 'claude-via-gateway', messages: [{ role: 'user', content: 'Hi' }] });
    const message = await anthropic.messages.create({ model: 'claude-via-gateway', max_tokens: 32, messages: [{ role: 'user', content: 'Hi' }] });
    expect(completion.choices[0]?.message.content).toContain('Docker networking');
    expect(message.content[0]?.type).toBe('text');
    const prefixedModels = await openai.models.list();
    const legacyModels = await new OpenAI({ apiKey: TEST_API_KEY, baseURL: `${ctx.baseUrl}/v1` }).models.list();
    expect(prefixedModels.data).toEqual(legacyModels.data);
  });

  it('keeps SSE completion and explicit session state across paths', async () => {
    const body = (message: string) => JSON.stringify({ model: 'claude-via-gateway', session_id: 'alias-session', messages: [{ role: 'user', content: message }] });
    const headers = { authorization: `Bearer ${TEST_API_KEY}`, 'content-type': 'application/json' };
    const first = await fetch(`${ctx.baseUrl}/v1/chat/completions`, { method: 'POST', headers, body: body('Remember the word PELICAN') });
    expect(first.status).toBe(200);
    const second = await fetch(`${ctx.baseUrl}/claude/v1/chat/completions`, { method: 'POST', headers, body: body('What did I ask you to remember?') });
    expect((await second.json() as any).choices[0].message.content).toContain('PELICAN');
    const stream = await fetch(`${ctx.baseUrl}/claude/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: 'claude-via-gateway', stream: true, messages: [{ role: 'user', content: 'Hi' }] }) });
    expect((await stream.text()).trim().endsWith('data: [DONE]')).toBe(true);
  });

  it('does not register a disabled prefixed shape', async () => {
    const disabled = await startTestApp({ ENABLE_ANTHROPIC_COMPAT_ROUTE: 'false' });
    try {
      const result = await disabled.app.inject({ method: 'POST', url: '/claude/v1/messages', headers: { 'x-api-key': TEST_API_KEY }, payload: { model: 'claude-via-gateway', max_tokens: 10, messages: [{ role: 'user', content: 'Hi' }] } });
      expect(result.statusCode).toBe(404);
      const statuses = await disabled.app.inject({ method: 'GET', url: '/v1/providers', headers: { 'x-api-key': TEST_API_KEY } });
      expect(statuses.json().providers[0].api.capabilities.some((c: { shape: string }) => c.shape === 'anthropic_messages')).toBe(false);
    } finally { await disabled.close(); }
  });
});
