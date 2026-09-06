/**
 * Spike 03 — empirical concurrency ceiling (closes R6) + whether the Agent
 * SDK/CLI has its own throttling distinguishable from account usage limits
 * (open question #2).
 *
 * Fires N concurrent query() calls for increasing N, records latency and
 * failure classification via SDKAssistantMessageError (see FINDINGS.md for
 * the resulting six-category error mapping table).
 *
 * Run: npm run spike:03
 */
import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { extractFinalText, section } from './lib.js';

const ISOLATED_OPTIONS: Options = { tools: [], settingSources: [] };

type Outcome = { ok: boolean; ms: number; error?: string; errorCategory?: string };

async function oneRequest(i: number): Promise<Outcome> {
  const start = Date.now();
  const messages: SDKMessage[] = [];
  try {
    for await (const msg of query({
      prompt: `Reply with just the number ${i}.`,
      options: ISOLATED_OPTIONS,
    })) {
      messages.push(msg);
      const anyMsg = msg as any;
      if (anyMsg.error) {
        return { ok: false, ms: Date.now() - start, error: anyMsg.error, errorCategory: anyMsg.error };
      }
    }
    const text = extractFinalText(messages);
    return { ok: text !== undefined, ms: Date.now() - start };
  } catch (err) {
    return { ok: false, ms: Date.now() - start, error: (err as Error).message };
  }
}

async function fireN(n: number): Promise<Outcome[]> {
  return Promise.all(Array.from({ length: n }, (_, i) => oneRequest(i)));
}

async function main() {
  for (const n of [1, 2, 3, 4, 6]) {
    section(`N = ${n} concurrent requests`);
    const outcomes = await fireN(n);
    const okCount = outcomes.filter((o) => o.ok).length;
    const avgMs = Math.round(outcomes.reduce((s, o) => s + o.ms, 0) / outcomes.length);
    const maxMs = Math.max(...outcomes.map((o) => o.ms));
    console.log(`ok=${okCount}/${n} avgMs=${avgMs} maxMs=${maxMs}`);
    for (const o of outcomes.filter((o) => !o.ok)) {
      console.log('  FAILURE:', o.error);
    }
  }
  section('DONE — record safe MAX_CONCURRENT_REQUESTS default in spikes/FINDINGS.md');
}

main().catch((err) => {
  console.error('Spike 03 failed:', err);
  process.exitCode = 1;
});
