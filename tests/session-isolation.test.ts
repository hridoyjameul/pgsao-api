import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, TEST_API_KEY } from './support/test-server.js';

/** HTTP-level version of spikes/spike-02-resume-isolation.ts — proves two concurrent session_ids never cross-contaminate through the full route/queue/session-manager pipeline. */
describe('session isolation across concurrent session_ids (closes R7 at the HTTP layer)', () => {
  let ctx: Awaited<ReturnType<typeof startTestApp>>;

  beforeAll(async () => {
    ctx = await startTestApp();
  });
  afterAll(async () => ctx.close());

  const seed = (sessionId: string, secret: string) =>
    fetch(`${ctx.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': TEST_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-via-gateway', max_tokens: 32, session_id: sessionId, messages: [{ role: 'user', content: `Remember the word ${secret}` }] }),
    });

  const ask = (sessionId: string) =>
    fetch(`${ctx.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': TEST_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-via-gateway', max_tokens: 32, session_id: sessionId, messages: [{ role: 'user', content: 'What did I ask you to remember?' }] }),
    });

  it('two sessions seeded with different secrets never leak into each other, even under concurrent resume', async () => {
    const sessionA = `sess-A-${Date.now()}`;
    const sessionB = `sess-B-${Date.now()}`;
    await Promise.all([seed(sessionA, 'PELICAN'), seed(sessionB, 'TROMBONE')]);

    const [resA, resB] = await Promise.all([ask(sessionA), ask(sessionB)]);
    const [bodyA, bodyB] = (await Promise.all([resA.json(), resB.json()])) as any[];

    expect(bodyA.content[0].text).toContain('PELICAN');
    expect(bodyA.content[0].text).not.toContain('TROMBONE');
    expect(bodyB.content[0].text).toContain('TROMBONE');
    expect(bodyB.content[0].text).not.toContain('PELICAN');
  });
});
