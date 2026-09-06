/**
 * Spike 06 — Phase 3 feasibility: can this gateway support OpenAI/Anthropic-
 * style tool-calling, where the MODEL proposes a tool call and the turn ends
 * immediately (stop_reason/finish_reason = tool_use/tool_calls), leaving
 * EXECUTION entirely to the caller — instead of the Agent SDK's own agentic
 * loop, which executes tools in-process and keeps going?
 *
 * Tests:
 *   1. Register a caller-style tool via createSdkMcpServer + a `canUseTool`
 *      callback that ALWAYS denies with `interrupt: true`. Does the model
 *      still emit a tool_use content block? Does the turn stop cleanly
 *      instead of the SDK retrying/looping?
 *   2. Resume that session with a synthetic tool_result content block (as if
 *      an external caller executed the tool and is reporting back) via
 *      streaming input mode. Does Claude pick it up and continue correctly?
 *
 * Run: npm run spike:06
 */
import { query, tool, createSdkMcpServer, type CanUseTool, type Options, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { logMessage, section } from './lib.js';

const capturedCalls: Array<{ toolName: string; input: Record<string, unknown>; toolUseID: string }> = [];

// Set right after query() is called, so canUseTool can call q.interrupt()
// itself (the Query object's OWN interrupt control method — distinct from
// PermissionResult's `interrupt` field, which spike-06 part 1 found causes
// an abrupt error_during_execution abort instead of a clean stop) to halt
// the underlying agent loop from continuing to retry after the denial.
let activeQuery: { interrupt(): Promise<unknown> } | undefined;

const denyAndCaptureThenInterrupt: CanUseTool = async (toolName, input, options) => {
  capturedCalls.push({ toolName, input, toolUseID: options.toolUseID });
  void activeQuery?.interrupt();
  return { behavior: 'deny', message: 'Execution deferred to the external caller (gateway simulation)', toolUseID: options.toolUseID };
};

const getWeatherTool = tool(
  'get_weather',
  'Get the current weather for a city',
  { city: z.string().describe('City name') },
  async () => {
    throw new Error('This handler should never run — canUseTool always denies first.');
  }
);

async function part1_ProposeToolCall() {
  section('1. Propose a tool call, deny+interrupt, inspect the result');
  const options: Options = {
    tools: [], // no built-in Bash/Read/etc — only the caller-declared MCP tool below
    settingSources: [],
    mcpServers: { gateway_tools: createSdkMcpServer({ name: 'gateway_tools', tools: [getWeatherTool] }) },
    canUseTool: denyAndCaptureThenInterrupt,
  };

  const q = query({
    prompt: 'What is the weather in Paris right now? You must use the get_weather tool to answer — do not guess.',
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
    console.log('Query threw after interrupt (checking if this is expected):', (err as Error).message);
  }

  const assistantMsgs = messages.filter((m) => m.type === 'assistant') as any[];
  for (const m of assistantMsgs) {
    const blocks = m.message?.content ?? [];
    for (const b of blocks) {
      if (b.type === 'tool_use') console.log('Found tool_use block:', JSON.stringify(b));
    }
  }
  const result = messages.find((m) => m.type === 'result') as any;
  console.log('Final result subtype:', result?.subtype, 'stop_reason:', result?.stop_reason, 'is_error:', result?.is_error);
  console.log('Captured canUseTool calls:', capturedCalls);
  console.log('sessionId:', sessionId);

  return { sessionId, capturedToolUseID: capturedCalls[0]?.toolUseID };
}

async function* toUserStream(content: any): AsyncIterable<SDKUserMessage> {
  yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null };
}

async function part2_ResumeWithToolResult(sessionId: string | undefined, toolUseID: string | undefined) {
  section('2. Resume with a synthetic tool_result (simulating external execution)');
  if (!sessionId || !toolUseID) {
    console.log('Skipped — part 1 did not produce a session id / tool_use id.');
    return;
  }
  // Re-specify the SAME tool/mcpServers config as part 1 — MCP server
  // registration is per-Options, not persisted automatically across resumed
  // calls, so omitting this may be why the model didn't recognize the
  // synthetic tool_result as answering ITS OWN prior tool_use.
  const options: Options = {
    tools: [],
    settingSources: [],
    resume: sessionId,
    mcpServers: { gateway_tools: createSdkMcpServer({ name: 'gateway_tools', tools: [getWeatherTool] }) },
  };
  const content = [{ type: 'tool_result', tool_use_id: toolUseID, content: 'Sunny, 22C, light breeze.' }];

  const messages: SDKMessage[] = [];
  try {
    for await (const msg of query({ prompt: toUserStream(content), options })) {
      logMessage('resume-tool-result', msg);
      messages.push(msg);
    }
    const result = messages.find((m) => m.type === 'result') as any;
    console.log('Final text:', result?.result);
    console.log('Recalled the synthetic weather?', /sunny|22/i.test(result?.result ?? ''));
  } catch (err) {
    console.log('Resume with synthetic tool_result FAILED:', (err as Error).message);
  }
}

async function part3_FreshFlattenedContinuation() {
  section('3. Fresh (non-resumed) query with the whole history + tool result flattened to text — no poisoned denial record');
  const options: Options = {
    tools: [],
    settingSources: [],
    mcpServers: { gateway_tools: createSdkMcpServer({ name: 'gateway_tools', tools: [getWeatherTool] }) },
    canUseTool: denyAndCaptureThenInterrupt,
  };
  const flattened = [
    'User: What is the weather in Paris right now? You must use the get_weather tool to answer — do not guess.',
    'Assistant: [called tool get_weather(city="Paris")]',
    'Tool result for get_weather: Sunny, 22C, light breeze.',
    'User: Given that tool result, answer the original question in one short sentence.',
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
  console.log('Recalled the synthetic weather?', /sunny|22/i.test(result?.result ?? ''));
}

async function main() {
  const { sessionId, capturedToolUseID } = await part1_ProposeToolCall();
  await part2_ResumeWithToolResult(sessionId, capturedToolUseID);
  await part3_FreshFlattenedContinuation();
  section('DONE — record findings in spikes/FINDINGS.md');
}

main().catch((err) => {
  console.error('Spike 06 failed:', err);
  process.exitCode = 1;
});
