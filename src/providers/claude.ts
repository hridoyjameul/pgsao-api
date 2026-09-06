import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { ApiError } from '../errors/api-error.js';
import type { ClaudeProvider, CredentialStatus, InternalClaudeEvent, InternalClaudeRequest, InternalClaudeResponse, InternalMessage } from './types.js';

// Every query() call is isolated from this machine's own Claude Code config:
//  - tools: []            no Bash/Read/Write/etc — MVP is plain chat/messages,
//                          tool-calling is Phase 3 (NG6). Untrusted HTTP callers
//                          must never get host filesystem/shell access.
//  - settingSources: []   "SDK isolation mode" — don't load ~/.claude/settings.json
//                          or project/local CLAUDE.md. A gateway caller gets pure
//                          model behavior, not this machine's own Claude Code config.
// See spikes/FINDINGS.md and spike-01-single-request.ts.
const BASE_OPTIONS: Options = { tools: [], settingSources: [] };

// Cached from the most recent SDKRateLimitEvent seen on any call (spikes/FINDINGS.md).
// A dedicated, typed signal for the account's subscription usage-pool status —
// distinct from the gateway's own concurrency queue (concurrency/queue.ts).
let lastRateLimitInfo: { status: 'allowed' | 'allowed_warning' | 'rejected'; resetsAt?: number } | null = null;

function checkRateLimitGate(): void {
  if (lastRateLimitInfo?.status === 'rejected') {
    const retryAfterSeconds = lastRateLimitInfo.resetsAt ? Math.max(1, Math.round((lastRateLimitInfo.resetsAt - Date.now()) / 1000)) : undefined;
    throw new ApiError('usage_limit_error', 'Claude account usage limit reached for the current window', { retryAfterSeconds });
  }
}

/** Maps SDKAssistantMessageError / SDKResultError subtypes to the gateway's six categories (spikes/FINDINGS.md). */
function mapSdkError(errorCode: string | undefined, resultSubtype?: string): ApiError {
  switch (errorCode) {
    case 'authentication_failed':
    case 'oauth_org_not_allowed':
    case 'account_on_hold':
      return new ApiError('credential_error', `Claude authentication error: ${errorCode}`);
    case 'billing_error':
      return new ApiError('usage_limit_error', 'Claude account billing error');
    case 'overloaded':
    case 'server_error':
      return new ApiError('provider_error', `Claude provider error: ${errorCode}`);
    case 'invalid_request':
    case 'model_not_found':
      return new ApiError('invalid_request_error', `Claude rejected the request: ${errorCode}`);
    default:
      break;
  }
  if (resultSubtype && resultSubtype !== 'success') {
    return new ApiError('provider_error', `Claude query ended abnormally: ${resultSubtype}`);
  }
  return new ApiError('provider_error', `Unexpected Claude provider error${errorCode ? `: ${errorCode}` : ''}`);
}

/**
 * Flatten a conversation into one prompt string. Proven in spikes/spike-01
 * (spikes/FINDINGS.md, "THE major architectural finding") — query()'s prompt
 * is a single string or a user-only streaming input, neither of which is a
 * native "replay this arbitrary history" API. A single trailing user turn is
 * passed through verbatim (the common case); multiple turns are rendered as
 * a "Role: content" transcript, which was empirically shown to preserve
 * context correctly for a single fresh (non-resumed) query() call.
 */
function buildPrompt(messages: InternalMessage[]): string {
  if (messages.length === 1 && messages[0]!.role === 'user') {
    return messages[0]!.content;
  }
  return messages.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n');
}

function buildOptions(request: InternalClaudeRequest, extra: Options = {}): Options {
  return {
    ...BASE_OPTIONS,
    model: request.model,
    systemPrompt: request.system,
    resume: request.resumeSessionId,
    ...extra,
  };
}

export class AgentSdkClaudeProvider implements ClaudeProvider {
  async sendMessage(request: InternalClaudeRequest): Promise<InternalClaudeResponse> {
    checkRateLimitGate();
    const prompt = buildPrompt(request.messages);
    const collected: SDKMessage[] = [];
    let sessionId: string | undefined;
    let actualModel: string | undefined;

    for await (const msg of query({ prompt, options: buildOptions(request) })) {
      collected.push(msg);
      if (msg.type === 'system' && (msg as any).subtype === 'init') {
        sessionId = (msg as any).session_id;
        actualModel = (msg as any).model;
      }
      if (msg.type === 'rate_limit_event') {
        lastRateLimitInfo = (msg as any).rate_limit_info;
      }
      if (msg.type === 'assistant' && (msg as any).error) {
        throw mapSdkError((msg as any).error);
      }
    }

    const result = collected.find((m) => m.type === 'result') as any;
    if (!result) {
      throw new ApiError('provider_error', 'Claude query completed with no result message');
    }
    if (result.is_error) {
      throw mapSdkError(undefined, result.subtype);
    }
    if (!sessionId) sessionId = result.session_id;

    return {
      sessionId: sessionId!,
      model: actualModel ?? result.model ?? request.model ?? 'unknown',
      text: result.result as string,
      stopReason: result.stop_reason ?? null,
      usage: {
        inputTokens: result.usage?.input_tokens ?? 0,
        outputTokens: result.usage?.output_tokens ?? 0,
      },
    };
  }

  async *streamMessage(request: InternalClaudeRequest): AsyncIterable<InternalClaudeEvent> {
    checkRateLimitGate();
    const prompt = buildPrompt(request.messages);
    let sessionId: string | undefined;
    let startEmitted = false;

    for await (const msg of query({ prompt, options: buildOptions(request, { includePartialMessages: true }) })) {
      if (msg.type === 'system' && (msg as any).subtype === 'init') {
        sessionId = (msg as any).session_id;
        if (!startEmitted) {
          startEmitted = true;
          yield { type: 'start', sessionId: sessionId ?? 'unknown', model: (msg as any).model ?? request.model ?? 'unknown' };
        }
        continue;
      }
      if (msg.type === 'rate_limit_event') {
        lastRateLimitInfo = (msg as any).rate_limit_info;
        continue;
      }
      if (msg.type === 'assistant' && (msg as any).error) {
        throw mapSdkError((msg as any).error);
      }
      if (msg.type === 'stream_event') {
        const event = (msg as any).event;
        if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          yield { type: 'text_delta', text: event.delta.text };
        }
        continue;
      }
      if (msg.type === 'result') {
        const result = msg as any;
        if (result.is_error) {
          throw mapSdkError(undefined, result.subtype);
        }
        yield {
          type: 'stop',
          stopReason: result.stop_reason ?? null,
          usage: {
            inputTokens: result.usage?.input_tokens ?? 0,
            outputTokens: result.usage?.output_tokens ?? 0,
          },
        };
      }
    }
  }

  async checkCredentials(): Promise<CredentialStatus> {
    const q = query({ prompt: 'ping', options: BASE_OPTIONS });
    try {
      const info = await q.accountInfo();
      for await (const _ of q) {
        /* drain so the subprocess exits cleanly */
      }
      return { ok: true, email: info.email, organization: info.organization, subscriptionType: info.subscriptionType };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }
}
