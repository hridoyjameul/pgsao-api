import type { OpenAiChatCompletionsRequest } from '../schemas/openai-messages.js';
import type { InternalClaudeEvent, InternalClaudeResponse, InternalToolDefinition } from '../providers/types.js';
import { resolveModelAlias } from '../config/models.js';
import { ApiError, type ApiErrorCategory } from '../errors/api-error.js';
import { generateChatCompletionId } from '../utils/ids.js';
import type { InternalRequestDraft } from './anthropic.js';

type OpenAiMessage = OpenAiChatCompletionsRequest['messages'][number];

/** Renders one message's content/tool_calls into one descriptive string — tool turns are pre-flattened here so providers/claude.ts's existing text-flattening needs no changes (spikes/FINDINGS.md's Phase 3 spike: flatten-and-restart, never resume, for tool-augmented turns). */
function flattenMessage(m: OpenAiMessage): string {
  const parts: string[] = [];
  if (m.content) {
    parts.push(typeof m.content === 'string' ? m.content : m.content.map((p) => p.text).join('\n'));
  }
  if (m.tool_calls?.length) {
    for (const tc of m.tool_calls) {
      parts.push(`[called tool ${tc.function.name} with input ${tc.function.arguments} (tool_use_id: ${tc.id})]`);
    }
  }
  if (m.role === 'tool' && m.tool_call_id) {
    const resultText = typeof m.content === 'string' ? m.content : '';
    parts.push(`[tool result for tool_use_id ${m.tool_call_id}: ${resultText}]`);
  }
  return parts.join('\n');
}

/** end_turn/max_tokens/stop_sequence/tool_use/... (Anthropic-native, per the SDK's own vocabulary) -> OpenAI's finish_reason enum. */
function stopReasonToFinishReason(stopReason: string | null): 'stop' | 'length' | 'tool_calls' | null {
  switch (stopReason) {
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    default:
      return stopReason === null ? null : 'stop';
  }
}

/** Inbound: validated OpenAI-shaped request -> the SAME shape-agnostic internal request type the Anthropic translator produces. */
export function openAiRequestToInternal(body: OpenAiChatCompletionsRequest): InternalRequestDraft {
  const modelResolution = resolveModelAlias(body.model);
  if (!modelResolution) {
    throw new ApiError('invalid_request_error', `Unknown model "${body.model}" — see GET /v1/models for the allow-list`, { param: 'model' });
  }
  const systemMessages = body.messages.filter((m) => m.role === 'system').map((m) => flattenMessage(m));
  // "tool" role messages carry a result, not a fresh conversational turn from
  // the caller — map them onto the internal 'user' role (the flattened text
  // already labels them as a tool result, see flattenMessage above).
  const conversation = body.messages.filter((m) => m.role !== 'system');

  const toolsAllowed = body.tool_choice !== 'none';
  const tools: InternalToolDefinition[] | undefined =
    toolsAllowed && body.tools?.length ? body.tools.map((t) => ({ name: t.function.name, description: t.function.description, parameters: t.function.parameters as any })) : undefined;

  return {
    model: modelResolution.resolved,
    system: systemMessages.length > 0 ? systemMessages.join('\n') : undefined,
    messages: conversation.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: flattenMessage(m) })),
    maxTokens: body.max_tokens,
    stream: body.stream ?? false,
    tools,
  };
}

/** Outbound (non-stream): internal response -> §8.A `chat.completion` object. */
export function internalResponseToOpenAi(response: InternalClaudeResponse) {
  const message = response.toolCalls?.length
    ? {
        role: 'assistant' as const,
        content: null,
        tool_calls: response.toolCalls.map((tc) => ({ id: tc.id, type: 'function' as const, function: { name: tc.name, arguments: JSON.stringify(tc.input) } })),
      }
    : { role: 'assistant' as const, content: response.text };
  return {
    id: generateChatCompletionId(),
    object: 'chat.completion' as const,
    created: Math.floor(Date.now() / 1000),
    model: response.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: stopReasonToFinishReason(response.stopReason),
      },
    ],
    usage: {
      prompt_tokens: response.usage.inputTokens,
      completion_tokens: response.usage.outputTokens,
      total_tokens: response.usage.inputTokens + response.usage.outputTokens,
    },
  };
}

/**
 * Outbound (error): ApiError -> OpenAI error shape — NO top-level wrapper
 * (the reverse of Anthropic's). Real OpenAI renders a bad API key as
 * `type: "invalid_request_error"` + `code: "invalid_api_key"`, NOT a
 * distinct "authentication_error" type (that's Anthropic's convention) —
 * remap here so each route matches its own real API's actual behavior.
 */
export function errorToOpenAiBody(category: ApiErrorCategory, message: string, opts: { param?: string; code?: string } = {}) {
  const type = category === 'authentication_error' ? 'invalid_request_error' : category;
  return { error: { message, type, param: opts.param ?? null, code: opts.code ?? null } };
}

/** Outbound (stream): normalized events -> §9 `chat.completion.chunk` frames, terminated by the literal `data: [DONE]` sentinel (handled by the route, not here — see routes/openai-compat.ts). */
export async function* toOpenAiChunks(events: AsyncIterable<InternalClaudeEvent>): AsyncGenerator<Record<string, unknown>> {
  const id = generateChatCompletionId();
  const created = Math.floor(Date.now() / 1000);
  let model = 'unknown';

  for await (const event of events) {
    if (event.type === 'start') {
      model = event.model;
      yield { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] };
    } else if (event.type === 'text_delta') {
      yield { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: event.text }, finish_reason: null }] };
    } else if (event.type === 'tool_calls') {
      yield {
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [
          {
            index: 0,
            delta: { tool_calls: event.toolCalls.map((tc, i) => ({ index: i, id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.input) } })) },
            finish_reason: null,
          },
        ],
      };
    } else if (event.type === 'stop') {
      yield { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: stopReasonToFinishReason(event.stopReason) }] };
    }
  }
}
