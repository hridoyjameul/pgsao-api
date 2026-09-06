import type { AnthropicMessagesRequest } from '../schemas/anthropic-messages.js';
import type { InternalClaudeEvent, InternalClaudeResponse, InternalMessage, InternalToolDefinition } from '../providers/types.js';
import { resolveModelAlias } from '../config/models.js';
import { ApiError, type ApiErrorCategory } from '../errors/api-error.js';
import { generateMessageId } from '../utils/ids.js';

export interface InternalRequestDraft {
  model: string | undefined;
  system?: string;
  messages: InternalMessage[];
  maxTokens?: number;
  stream: boolean;
  tools?: InternalToolDefinition[];
}

/** Renders one message's content (string, or a mix of text/tool_use/tool_result blocks) into one descriptive string — tool turns are pre-flattened here so providers/claude.ts's existing text-flattening needs no changes (spikes/FINDINGS.md's Phase 3 spike: flatten-and-restart, never resume, for tool-augmented turns). */
function flattenContent(content: AnthropicMessagesRequest['messages'][number]['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map((b: any) => {
      if (b.type === 'text') return b.text;
      if (b.type === 'tool_use') return `[called tool ${b.name} with input ${JSON.stringify(b.input)} (tool_use_id: ${b.id})]`;
      if (b.type === 'tool_result') {
        const resultText = typeof b.content === 'string' ? b.content : (b.content ?? []).map((c: any) => c.text).join('\n');
        return `[tool result for tool_use_id ${b.tool_use_id}${b.is_error ? ' (error)' : ''}: ${resultText}]`;
      }
      return '';
    })
    .join('\n');
}

/** Inbound: validated Anthropic-shaped request -> shape-agnostic internal request (PRD §6.8). */
export function anthropicRequestToInternal(body: AnthropicMessagesRequest): InternalRequestDraft {
  const modelResolution = resolveModelAlias(body.model);
  if (!modelResolution) {
    throw new ApiError('invalid_request_error', `Unknown model "${body.model}" — see GET /v1/models for the allow-list`, { param: 'model' });
  }
  const toolsAllowed = body.tool_choice?.type !== 'none';
  const tools: InternalToolDefinition[] | undefined = toolsAllowed && body.tools?.length ? body.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.input_schema as any })) : undefined;

  return {
    model: modelResolution.resolved,
    system: body.system,
    messages: body.messages.map((m) => ({ role: m.role, content: flattenContent(m.content) })),
    maxTokens: body.max_tokens,
    stream: body.stream ?? false,
    tools,
  };
}

/** Outbound (non-stream): internal response -> §8.B Anthropic `message` object. */
export function internalResponseToAnthropic(response: InternalClaudeResponse) {
  const content = response.toolCalls?.length
    ? response.toolCalls.map((tc) => ({ type: 'tool_use' as const, id: tc.id, name: tc.name, input: tc.input }))
    : [{ type: 'text' as const, text: response.text }];
  return {
    id: generateMessageId(),
    type: 'message' as const,
    role: 'assistant' as const,
    model: response.model,
    content,
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
  let blockIndex = 0;
  let textBlockOpen = false;

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
    } else if (event.type === 'text_delta') {
      if (!textBlockOpen) {
        textBlockOpen = true;
        yield { event: 'content_block_start', data: { type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' } } };
      }
      yield { event: 'content_block_delta', data: { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: event.text } } };
    } else if (event.type === 'tool_calls') {
      if (textBlockOpen) {
        yield { event: 'content_block_stop', data: { type: 'content_block_stop', index: blockIndex } };
        textBlockOpen = false;
        blockIndex++;
      }
      for (const tc of event.toolCalls) {
        const index = blockIndex++;
        yield { event: 'content_block_start', data: { type: 'content_block_start', index, content_block: { type: 'tool_use', id: tc.id, name: tc.name, input: {} } } };
        // Real Anthropic streaming fills `input` incrementally via
        // input_json_delta chunks accumulated client-side; sending the whole
        // JSON as one chunk is spec-valid (the real @anthropic-ai/sdk stream
        // helper just concatenates partial_json fragments before parsing).
        yield { event: 'content_block_delta', data: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tc.input) } } };
        yield { event: 'content_block_stop', data: { type: 'content_block_stop', index } };
      }
    } else if (event.type === 'stop') {
      if (textBlockOpen) {
        yield { event: 'content_block_stop', data: { type: 'content_block_stop', index: blockIndex } };
        textBlockOpen = false;
      }
      yield {
        event: 'message_delta',
        data: { type: 'message_delta', delta: { stop_reason: event.stopReason, stop_sequence: null }, usage: { output_tokens: event.usage.outputTokens } },
      };
      yield { event: 'message_stop', data: { type: 'message_stop' } };
    }
  }
}
