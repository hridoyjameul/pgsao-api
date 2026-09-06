import type { OpenAiChatCompletionsRequest } from '../schemas/openai-messages.js';
import type { InternalClaudeEvent, InternalClaudeResponse } from '../providers/types.js';
import { resolveModelAlias } from '../config/models.js';
import { ApiError, type ApiErrorCategory } from '../errors/api-error.js';
import { generateChatCompletionId } from '../utils/ids.js';
import type { InternalRequestDraft } from './anthropic.js';

function flattenContent(content: OpenAiChatCompletionsRequest['messages'][number]['content']): string {
  if (typeof content === 'string') return content;
  return content.map((p) => p.text).join('\n');
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
  const systemMessages = body.messages.filter((m) => m.role === 'system').map((m) => flattenContent(m.content));
  const conversation = body.messages.filter((m): m is typeof m & { role: 'user' | 'assistant' } => m.role !== 'system');

  return {
    model: modelResolution.resolved,
    system: systemMessages.length > 0 ? systemMessages.join('\n') : undefined,
    messages: conversation.map((m) => ({ role: m.role, content: flattenContent(m.content) })),
    maxTokens: body.max_tokens,
    stream: body.stream ?? false,
  };
}

/** Outbound (non-stream): internal response -> §8.A `chat.completion` object. */
export function internalResponseToOpenAi(response: InternalClaudeResponse) {
  return {
    id: generateChatCompletionId(),
    object: 'chat.completion' as const,
    created: Math.floor(Date.now() / 1000),
    model: response.model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant' as const, content: response.text },
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
    } else if (event.type === 'stop') {
      yield { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: stopReasonToFinishReason(event.stopReason) }] };
    }
  }
}
