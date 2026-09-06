/**
 * Spike 02 — explicit resume(sessionId) isolation proof (closes R7).
 *
 * Proves that resuming session A never leaks context into session B, both
 * sequentially and under concurrent execution, and that the SDK's own
 * `continue` shortcut is never used anywhere in this file.
 *
 * Run: npm run spike:02
 */
import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { extractFinalText, extractSessionId, logMessage, section } from './lib.js';

const ISOLATED_OPTIONS: Options = { tools: [], settingSources: [] };

async function seedSession(secret: string): Promise<string> {
  const messages: SDKMessage[] = [];
  for await (const msg of query({
    prompt: `Remember this secret word for later: "${secret}". Just acknowledge you'll remember it, in five words or fewer.`,
    options: ISOLATED_OPTIONS,
  })) {
    messages.push(msg);
  }
  const sessionId = extractSessionId(messages);
  if (!sessionId) throw new Error('No session_id captured from init system message');
  return sessionId;
}

async function askSecret(sessionId: string, label: string): Promise<string | undefined> {
  const messages: SDKMessage[] = [];
  // `resume` is ALWAYS given an explicit sessionId here — this file must never
  // call `Options.continue` (the SDK's "continue most recent" shortcut),
  // which PRD R7 flags as unsafe for multi-session use.
  for await (const msg of query({
    prompt: 'What is the secret word I asked you to remember? Answer with just the word.',
    options: { ...ISOLATED_OPTIONS, resume: sessionId },
  })) {
    logMessage(label, msg);
    messages.push(msg);
  }
  return extractFinalText(messages);
}

async function main() {
  section('Seeding two sessions with different secrets');
  const [sessionA, sessionB] = await Promise.all([seedSession('PELICAN'), seedSession('TROMBONE')]);
  console.log('sessionA:', sessionA, 'sessionB:', sessionB);

  section('Sequential resume — A then B');
  const seqA = await askSecret(sessionA, 'seq-A');
  const seqB = await askSecret(sessionB, 'seq-B');
  console.log('seqA answer:', seqA, '(expect PELICAN)');
  console.log('seqB answer:', seqB, '(expect TROMBONE)');
  const sequentialOk = /pelican/i.test(seqA ?? '') && /trombone/i.test(seqB ?? '');
  console.log('Sequential isolation OK?', sequentialOk);

  section('Concurrent resume — A and B in parallel (race check)');
  const [concA, concB] = await Promise.all([askSecret(sessionA, 'conc-A'), askSecret(sessionB, 'conc-B')]);
  console.log('concA answer:', concA, '(expect PELICAN)');
  console.log('concB answer:', concB, '(expect TROMBONE)');
  const concurrentOk = /pelican/i.test(concA ?? '') && /trombone/i.test(concB ?? '');
  console.log('Concurrent isolation OK?', concurrentOk);

  section('RESULT');
  console.log('R7 closed?', sequentialOk && concurrentOk);
}

main().catch((err) => {
  console.error('Spike 02 failed:', err);
  process.exitCode = 1;
});
