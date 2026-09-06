/**
 * Spike 01 — single request, isolation options, credential probe, and the
 * multi-turn-history question (how does a STATELESS caller's full message
 * history get replayed into a FRESH query() call with no resume?).
 *
 * Run: npm run spike:01
 */
import { query, type Options, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { extractFinalText, logMessage, section } from './lib.js';

// Gateway isolation baseline — every InternalClaudeRequest → query() call in
// providers/claude.ts should start from options like this:
//   - tools: []            → no Bash/Read/Write/etc. against the host. MVP is
//                             plain chat/messages; tool-calling is Phase 3 (NG6).
//   - settingSources: []   → "SDK isolation mode": don't load the host's own
//                             ~/.claude/settings.json or project/local CLAUDE.md.
//                             A gateway caller should get pure model behavior,
//                             not whatever this machine's Claude Code is configured to do.
const ISOLATED_OPTIONS: Options = {
  tools: [],
  settingSources: [],
};

async function runPlainRequest() {
  section('1a. Plain single-turn request');
  const messages: SDKMessage[] = [];
  for await (const msg of query({
    prompt: 'In one short sentence, explain what Docker networking does.',
    options: ISOLATED_OPTIONS,
  })) {
    logMessage('plain', msg);
    messages.push(msg);
  }
  console.log('Final text:', extractFinalText(messages));
}

async function runAccountInfoProbe() {
  section('1b. accountInfo() probe (credential status)');
  // accountInfo() is listed as a "control request" method on Query — the SDK
  // docs group these under "only supported when streaming input/output is
  // used." Test whether it works on a plain-string query() too, since that's
  // the simpler mode we'd prefer for stateless single-turn calls.
  const q = query({ prompt: 'Say OK.', options: ISOLATED_OPTIONS });
  try {
    const info = await q.accountInfo();
    console.log('accountInfo() (plain-string mode) succeeded:', info);
  } catch (err) {
    console.log('accountInfo() (plain-string mode) FAILED:', (err as Error).message);
  }
  // Drain the query so the process can exit cleanly.
  for await (const _ of q) {
    /* drain */
  }
}

async function* toUserStream(turns: string[]): AsyncIterable<SDKUserMessage> {
  for (const text of turns) {
    yield {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    };
  }
}

async function runHistoryApproachA_FlattenToPromptText() {
  section('2a. Multi-turn history via flattened prompt text');
  const transcript = [
    'User: My favorite color is teal.',
    'Assistant: Got it — teal.',
    'User: What is my favorite color? Answer with just the color word.',
  ].join('\n');
  const messages: SDKMessage[] = [];
  for await (const msg of query({ prompt: transcript, options: ISOLATED_OPTIONS })) {
    logMessage('flatten', msg);
    messages.push(msg);
  }
  const answer = extractFinalText(messages);
  console.log('Final text:', answer);
  console.log('Recalled "teal"?', /teal/i.test(answer ?? ''));
}

async function runHistoryApproachB_StreamingUserOnly() {
  section('2b. Multi-turn history via streaming input, user-role turns only');
  // SDKUserMessage.message is typed as MessageParam but documented as "role
  // user" specifically. This sends only the user turns (no assistant replay)
  // to see whether Claude can infer context from user-side turns alone —
  // expected to fail/be lossy, included to confirm that experimentally.
  const messages: SDKMessage[] = [];
  for await (const msg of query({
    prompt: toUserStream(['My favorite color is teal.', 'What is my favorite color? Answer with just the color word.']),
    options: ISOLATED_OPTIONS,
  })) {
    logMessage('stream-user-only', msg);
    messages.push(msg);
  }
  console.log('Final text:', extractFinalText(messages));
}

async function runHistoryApproachC_StreamingMixedRoles() {
  section('2c. Multi-turn history via streaming input, mixed user+assistant roles (experimental)');
  // MessageParam itself allows role "assistant". SDKUserMessage's *type* does
  // not forbid it structurally. Test whether the CLI bridge accepts an
  // assistant-role entry injected into the user-message stream as a way to
  // replay prior assistant turns verbatim (would give exact-fidelity replay
  // without flattening into text, if accepted).
  async function* mixedStream(): AsyncIterable<SDKUserMessage> {
    yield { type: 'user', message: { role: 'user', content: 'My favorite color is teal.' }, parent_tool_use_id: null };
    yield {
      type: 'user',
      // Deliberately mis-typed as role "assistant" to probe bridge behavior.
      message: { role: 'assistant', content: 'Got it — teal.' } as unknown as SDKUserMessage['message'],
      parent_tool_use_id: null,
    };
    yield {
      type: 'user',
      message: { role: 'user', content: 'What is my favorite color? Answer with just the color word.' },
      parent_tool_use_id: null,
    };
  }
  try {
    const messages: SDKMessage[] = [];
    for await (const msg of query({ prompt: mixedStream(), options: ISOLATED_OPTIONS })) {
      logMessage('stream-mixed', msg);
      messages.push(msg);
    }
    const answer = extractFinalText(messages);
    console.log('Final text:', answer);
    console.log('Recalled "teal"?', /teal/i.test(answer ?? ''));
  } catch (err) {
    console.log('Mixed-role streaming input FAILED:', (err as Error).message);
  }
}

async function main() {
  await runPlainRequest();
  await runAccountInfoProbe();
  await runHistoryApproachA_FlattenToPromptText();
  await runHistoryApproachB_StreamingUserOnly();
  await runHistoryApproachC_StreamingMixedRoles();
  section('DONE — record the winning history-replay approach in spikes/FINDINGS.md');
}

main().catch((err) => {
  console.error('Spike 01 failed:', err);
  process.exitCode = 1;
});
