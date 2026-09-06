/**
 * Spike 07 — parallel tool calls: does canUseTool fire for ALL tool_use
 * blocks in one turn before our interrupt() takes effect, or does the
 * interrupt race ahead and cause us to miss the second (and later) calls?
 * Flagged as untested in spikes/FINDINGS.md's Phase 3 spike.
 *
 * Run: npm run spike:07
 */
import { query, tool, createSdkMcpServer, type CanUseTool, type Options, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { logMessage, section } from './lib.js';

const capturedCalls: Array<{ toolName: string; input: Record<string, unknown>; toolUseID: string }> = [];
let activeQuery: { interrupt(): Promise<unknown> } | undefined;

// FIX under test: interrupting immediately on the FIRST capture (spike-06's
// original approach) cut off before a SECOND, parallel tool_use block's own
// canUseTool call even fired — only 1 of 2 got captured. Debounce instead:
// each new capture resets the timer, so interrupt() only actually fires once
// no NEW capture has arrived for a short window, letting same-turn siblings
// land first.
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
const DEBOUNCE_MS = 50;

const denyAndCaptureThenInterrupt: CanUseTool = async (toolName, input, options) => {
  capturedCalls.push({ toolName, input, toolUseID: options.toolUseID });
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => void activeQuery?.interrupt(), DEBOUNCE_MS);
  return { behavior: 'deny', message: 'Execution deferred to the external caller (gateway simulation)', toolUseID: options.toolUseID };
};

const getWeatherTool = tool('get_weather', 'Get the current weather for a city', { city: z.string().describe('City name') }, async () => {
  throw new Error('unreachable — canUseTool always denies first');
});
const getTimeTool = tool('get_time', 'Get the current local time for a city', { city: z.string().describe('City name') }, async () => {
  throw new Error('unreachable — canUseTool always denies first');
});

async function part1_ProposeTwoToolCallsAtOnce() {
  section('1. Ask for two independent tool calls in one turn, deny+interrupt both, inspect captures');
  const options: Options = {
    tools: [],
    settingSources: [],
    mcpServers: { gateway_tools: createSdkMcpServer({ name: 'gateway_tools', tools: [getWeatherTool, getTimeTool] }) },
    canUseTool: denyAndCaptureThenInterrupt,
  };

  const q = query({
    prompt:
      'What is the weather in Paris AND what time is it in Tokyo right now? ' +
      'You MUST call both the get_weather tool (for Paris) and the get_time tool (for Tokyo) — ' +
      'call them together in the same turn, not one after the other. Do not guess either answer.',
    options,
  });
  activeQuery = q;

  const messages: SDKMessage[] = [];
  let sessionId: string | undefined;
  try {
    for await (const msg of q) {
      logMessage('propose', msg);
      messages.push(msg);
      if (msg.type === 'system' && (msg as any).subtype === 'init') sessionId = (msg as any).session_id;
    }
  } catch (err) {
    console.log('Query threw after interrupt (expected):', (err as Error).message);
  }

  const assistantMsgs = messages.filter((m) => m.type === 'assistant') as any[];
  const toolUseBlocks: any[] = [];
  for (const m of assistantMsgs) {
    for (const b of m.message?.content ?? []) {
      if (b.type === 'tool_use') toolUseBlocks.push(b);
    }
  }
  console.log('tool_use blocks in assistant message(s):', toolUseBlocks.length, JSON.stringify(toolUseBlocks.map((b) => ({ name: b.name, input: b.input }))));

  const result = messages.find((m) => m.type === 'result') as any;
  console.log('permission_denials from result:', JSON.stringify(result?.permission_denials));
  console.log('Captured via canUseTool:', JSON.stringify(capturedCalls));
  console.log(`\n=> Captured ${capturedCalls.length} of ${toolUseBlocks.length} proposed tool_use block(s).`);

  return { sessionId, calls: capturedCalls.slice() };
}

async function* toUserStream(content: any): AsyncIterable<SDKUserMessage> {
  yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null };
}

async function part2_FreshFlattenedContinuationWithBothResults(calls: typeof capturedCalls) {
  section('2. Fresh (non-resumed) continuation with BOTH tool results flattened in — mirrors providers/claude.ts buildPrompt');
  if (calls.length < 2) {
    console.log(`Only ${calls.length} call(s) captured — skipping the both-results continuation test.`);
    return;
  }
  const options: Options = {
    tools: [],
    settingSources: [],
    mcpServers: { gateway_tools: createSdkMcpServer({ name: 'gateway_tools', tools: [getWeatherTool, getTimeTool] }) },
    canUseTool: denyAndCaptureThenInterrupt,
  };

  const toolResultLines = calls.map((c, i) => {
    const fakeResult = c.toolName.includes('get_weather') ? 'Sunny, 22C, light breeze.' : '14:32 local time.';
    return `[tool result for tool_use_id ${c.toolUseID}: ${fakeResult}]`;
  });
  const flattened = [
    'User: What is the weather in Paris AND what time is it in Tokyo right now? You MUST call both the get_weather tool (for Paris) and the get_time tool (for Tokyo).',
    `Assistant: [called ${calls.length} tools: ${calls.map((c) => `${c.toolName}(${JSON.stringify(c.input)})`).join(', ')}]`,
    ...toolResultLines,
    'User: Given both tool results, answer the original question in one short sentence covering both.',
  ].join('\n');

  const messages: SDKMessage[] = [];
  try {
    for await (const msg of query({ prompt: flattened, options })) {
      logMessage('fresh-flat', msg);
      messages.push(msg);
    }
  } catch (err) {
    console.log('Fresh flattened continuation threw:', (err as Error).message);
  }
  const result = messages.find((m) => m.type === 'result') as any;
  console.log('Final text:', result?.result);
  console.log('is_error:', result?.is_error, 'subtype:', result?.subtype);
  console.log('Recalled BOTH synthetic results?', /sunny|22/i.test(result?.result ?? '') && /14:32|2:32/i.test(result?.result ?? ''));
}

async function main() {
  const { calls } = await part1_ProposeTwoToolCallsAtOnce();
  await part2_FreshFlattenedContinuationWithBothResults(calls);
  section('DONE — record findings in spikes/FINDINGS.md');
}

main().catch((err) => {
  console.error('Spike 07 failed:', err);
  process.exitCode = 1;
});
