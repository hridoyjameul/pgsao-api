import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { startTestApp, TEST_API_KEY } from './support/test-server.js';

describe('Tool/function-calling (PRD §23/NG6, Phase 3)', () => {
  let ctx: Awaited<ReturnType<typeof startTestApp>>;
  let openai: OpenAI;
  let anthropic: Anthropic;

  beforeAll(async () => {
    ctx = await startTestApp();
    openai = new OpenAI({ apiKey: TEST_API_KEY, baseURL: `${ctx.baseUrl}/v1` });
    anthropic = new Anthropic({ apiKey: TEST_API_KEY, baseURL: ctx.baseUrl });
  });
  afterAll(async () => ctx.close());

  describe('Anthropic route (/v1/messages)', () => {
    it('proposes a tool call: stop_reason tool_use, a tool_use content block', async () => {
      const message = await anthropic.messages.create({
        model: 'claude-via-gateway',
        max_tokens: 256,
        tools: [{ name: 'get_weather', description: 'Get current weather', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }],
        messages: [{ role: 'user', content: 'What is the weather in Paris?' }],
      });
      expect(message.stop_reason).toBe('tool_use');
      expect(message.content[0]).toMatchObject({ type: 'tool_use', name: 'get_weather' });
    });

    it('continuation with a tool_result block produces a normal text answer (flatten-and-restart, not resume)', async () => {
      const message = await anthropic.messages.create({
        model: 'claude-via-gateway',
        max_tokens: 256,
        tools: [{ name: 'get_weather', description: 'Get current weather', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
        messages: [
          { role: 'user', content: 'What is the weather in Paris?' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_abc', name: 'get_weather', input: { city: 'Paris' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_abc', content: 'Sunny, 22C' }] },
        ],
      });
      expect(message.stop_reason).toBe('end_turn');
      expect((message.content[0] as any).text).toContain('Sunny, 22C');
    });

    it('tool_choice "none" suppresses tool use even when tools are declared', async () => {
      const message = await anthropic.messages.create({
        model: 'claude-via-gateway',
        max_tokens: 256,
        tools: [{ name: 'get_weather', description: 'Get current weather', input_schema: { type: 'object', properties: {} } }],
        tool_choice: { type: 'none' },
        messages: [{ role: 'user', content: 'Hi' }],
      });
      expect(message.stop_reason).not.toBe('tool_use');
    });

    it('forcing a specific named tool via tool_choice is rejected (not supported yet)', async () => {
      await expect(
        anthropic.messages.create({
          model: 'claude-via-gateway',
          max_tokens: 256,
          tools: [{ name: 'get_weather', description: 'x', input_schema: { type: 'object', properties: {} } }],
          tool_choice: { type: 'tool', name: 'get_weather' },
          messages: [{ role: 'user', content: 'Hi' }],
        })
      ).rejects.toMatchObject({ status: 400 });
    });

    it('streaming a tool-use response emits a tool_use content_block', async () => {
      const stream = await anthropic.messages.create({
        model: 'claude-via-gateway',
        max_tokens: 256,
        stream: true,
        tools: [{ name: 'get_weather', description: 'x', input_schema: { type: 'object', properties: {} } }],
        messages: [{ role: 'user', content: 'What is the weather in Paris?' }],
      });
      let sawToolUseBlock = false;
      for await (const event of stream) {
        if (event.type === 'content_block_start' && (event.content_block as any).type === 'tool_use') sawToolUseBlock = true;
      }
      expect(sawToolUseBlock).toBe(true);
    });
  });

  describe('OpenAI route (/v1/chat/completions)', () => {
    it('proposes a tool call: finish_reason tool_calls, a tool_calls array', async () => {
      const completion = await openai.chat.completions.create({
        model: 'claude-via-gateway',
        tools: [{ type: 'function', function: { name: 'get_weather', description: 'Get current weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }],
        messages: [{ role: 'user', content: 'What is the weather in Paris?' }],
      });
      expect(completion.choices[0]?.finish_reason).toBe('tool_calls');
      expect(completion.choices[0]?.message.tool_calls?.[0]).toMatchObject({ type: 'function', function: { name: 'get_weather' } });
    });

    it('continuation with a tool role message produces a normal text answer', async () => {
      const completion = await openai.chat.completions.create({
        model: 'claude-via-gateway',
        tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
        messages: [
          { role: 'user', content: 'What is the weather in Paris?' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'call_abc', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] },
          { role: 'tool', tool_call_id: 'call_abc', content: 'Sunny, 22C' },
        ],
      });
      expect(completion.choices[0]?.finish_reason).toBe('stop');
      expect(completion.choices[0]?.message.content).toContain('Sunny, 22C');
    });

    it('tool_choice "none" suppresses tool use even when tools are declared', async () => {
      const completion = await openai.chat.completions.create({
        model: 'claude-via-gateway',
        tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: {} } } }],
        tool_choice: 'none',
        messages: [{ role: 'user', content: 'Hi' }],
      });
      expect(completion.choices[0]?.finish_reason).not.toBe('tool_calls');
    });

    it('legacy functions/function_call fields are rejected', async () => {
      await expect(
        openai.chat.completions.create({
          model: 'claude-via-gateway',
          messages: [{ role: 'user', content: 'Hi' }],
          functions: [{ name: 'get_weather', parameters: {} }],
        } as any)
      ).rejects.toMatchObject({ status: 400 });
    });

    it('streaming a tool-call response emits a tool_calls delta', async () => {
      const stream = await openai.chat.completions.create({
        model: 'claude-via-gateway',
        stream: true,
        tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: {} } } }],
        messages: [{ role: 'user', content: 'What is the weather in Paris?' }],
      });
      let sawToolCallDelta = false;
      for await (const chunk of stream) {
        if (chunk.choices[0]?.delta?.tool_calls?.length) sawToolCallDelta = true;
      }
      expect(sawToolCallDelta).toBe(true);
    });
  });

  // Regression coverage for spikes/spike-07-parallel-tool-calls.ts: interrupting
  // on the FIRST captured call cut off a second, parallel tool_use block's own
  // canUseTool before it even fired (fixed with a debounce in providers/claude.ts).
  describe('Parallel tool calls (model calling >1 tool in one turn)', () => {
    beforeAll(() => {
      ctx.claudeProvider.simulateParallelToolCalls = true;
    });
    afterAll(() => {
      ctx.claudeProvider.simulateParallelToolCalls = false;
    });

    const tools = [
      { name: 'get_weather', description: 'Get current weather', input_schema: { type: 'object', properties: { city: { type: 'string' } } } },
      { name: 'get_time', description: 'Get current local time', input_schema: { type: 'object', properties: { city: { type: 'string' } } } },
    ] as const;

    it('Anthropic route: proposes both tool calls in one content array', async () => {
      const message = await anthropic.messages.create({
        model: 'claude-via-gateway',
        max_tokens: 256,
        tools: tools as any,
        messages: [{ role: 'user', content: 'What is the weather in Paris and the time in Tokyo?' }],
      });
      expect(message.stop_reason).toBe('tool_use');
      const names = message.content.map((b: any) => b.name).sort();
      expect(names).toEqual(['get_time', 'get_weather']);
    });

    it('Anthropic route: continuation with both tool_result blocks answered produces one combined answer', async () => {
      const message = await anthropic.messages.create({
        model: 'claude-via-gateway',
        max_tokens: 256,
        tools: tools as any,
        messages: [
          { role: 'user', content: 'What is the weather in Paris and the time in Tokyo?' },
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Paris' } },
              { type: 'tool_use', id: 'toolu_2', name: 'get_time', input: { city: 'Tokyo' } },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'toolu_1', content: 'Sunny, 22C' },
              { type: 'tool_result', tool_use_id: 'toolu_2', content: '14:32 local' },
            ],
          },
        ],
      });
      expect(message.stop_reason).toBe('end_turn');
      const text = (message.content[0] as any).text;
      expect(text).toContain('Sunny, 22C');
      expect(text).toContain('14:32 local');
    });

    it('OpenAI route: proposes both tool calls in one tool_calls array', async () => {
      const completion = await openai.chat.completions.create({
        model: 'claude-via-gateway',
        tools: tools.map((t) => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.input_schema } })),
        messages: [{ role: 'user', content: 'What is the weather in Paris and the time in Tokyo?' }],
      });
      expect(completion.choices[0]?.finish_reason).toBe('tool_calls');
      const names = completion.choices[0]?.message.tool_calls?.map((c: any) => c.function.name).sort();
      expect(names).toEqual(['get_time', 'get_weather']);
    });
  });
});
