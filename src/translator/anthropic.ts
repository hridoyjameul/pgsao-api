import type { AnthropicMessagesRequest } from '../schemas/anthropic-messages.js';
import type { InternalClaudeEvent, InternalClaudeResponse, InternalMessage } from '../providers/types.js';
import { resolveModelAlias } from '../config/models.js';
import { ApiError, type ApiErrorCategory } from '../errors/api-error.js';
import { generateMessageId } from '../utils/ids.js';

export interface InternalRequestDraft {
  model: string | undefined;
  system?: string;
  messages: InternalMessage[];
  maxTokens?: number;
  stream: boolean;
}

function flattenContent(content: AnthropicMessagesRequest['messages'][number]['content']): string {
  if (typeof content === 'string') return content;
  return content.map((b) => b.text).join('\n');
}

/** Inbound: validated Anthropic-shaped request -> shape-agnostic internal request (PRD §6.8). */
export function anthropicRequestToInternal(body: AnthropicMessagesRequest): InternalRequestDraft {
  const modelResolution = resolveModelAlias(body.model);
  if (!modelResolution) {
    throw new ApiError('invalid_request_error', `Unknown model "${body.model}" — see GET /v1/models for the allow-list`, { param: 'model' });
  }
  return {
    model: modelResolution.resolved,
    system: body.system,
    messages: body.messages.map((m) => ({ role: m.role, content: flattenContent(m.content) })),
    maxTokens: body.max_tokens,
    stream: body.stream ?? false,
  };
}

/** Outbound (non-stream): internal response -> §8.B Anthropic `message` object. */
export function internalResponseToAnthropic(response: InternalClaudeResponse) {
  return {
    id: generateMessageId(),
    type: 'message' as const,
    role: 'assistant' as const,
    model: response.model,
    content: [{ type: 'text' as const, text: response.text }],
    // The SDK's stop_reason is already Anthropic-native vocabulary — pass through as-is.
    stop_reason: response.stopReason,
    stop_sequence: null,
    usage: { input_tokens: response.usage.inputTokens, output_tokens: response.usage.outputTokens },
  };
}

/** Outbound (error): ApiError -> §13 Anthropic error shape, WITH the required top-level "type":"error" wrapper. */
export function errorToAnthropicBody(category: ApiErrorCategory, message: string) {
  return { type: 'error' as const, error: { type: category, message } };
}

export interface AnthropicSSEFrame {
  event: string;
  data: unknown;
}

/** Outbound (stream): normalized events -> named Anthropic SSE events (PRD §9). */
export async function* toAnthropicSSE(events: AsyncIterable<InternalClaudeEvent>): AsyncGenerator<AnthropicSSEFrame> {
  const id = generateMessageId();
  let model = 'unknown';

  for await (const event of events) {
    if (event.type === 'start') {
      model = event.model;
      yield {
        event: 'message_start',
        data: {
          type: 'message_start',
          message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
        },
      };
      yield { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } };
    } else if (event.type === 'text_delta') {
      yield { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: event.text } } };
    } else if (event.type === 'stop') {
      yield { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } };
      yield {
        event: 'message_delta',
        data: { type: 'message_delta', delta: { stop_reason: event.stopReason, stop_sequence: null }, usage: { output_tokens: event.usage.outputTokens } },
      };
      yield { event: 'message_stop', data: { type: 'message_stop' } };
    }
  }
}
