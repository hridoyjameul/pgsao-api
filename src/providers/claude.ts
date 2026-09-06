import { createSdkMcpServer, query, tool, type CanUseTool, type Options, type Query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { ApiError } from '../errors/api-error.js';
import { jsonSchemaObjectToZodRawShape } from '../utils/json-schema-to-zod.js';
import type { ClaudeProvider, CredentialStatus, InternalClaudeEvent, InternalClaudeRequest, InternalClaudeResponse, InternalMessage, InternalToolCall, InternalToolDefinition } from './types.js';

// Every query() call is isolated from this machine's own Claude Code config:
//  - tools: []            no Bash/Read/Write/etc — MVP is plain chat/messages,
//                          tool-calling is Phase 3 (NG6). Untrusted HTTP callers
//                          must never get host filesystem/shell access.
//  - settingSources: []   "SDK isolation mode" — don't load ~/.claude/settings.json
//                          or project/local CLAUDE.md. A gateway caller gets pure
//                          model behavior, not this machine's own Claude Code config.
// See spikes/FINDINGS.md and spike-01-single-request.ts.
const BASE_OPTIONS: Options = { tools: [], settingSources: [] };

// Caller-declared tools (PRD §23/NG6, Phase 3) are registered under this one
// ad-hoc MCP server name per call; Claude sees them as mcp__gateway_tools__<name>.
const TOOL_SERVER_NAME = 'gateway_tools';
const TOOL_PREFIX = `mcp__${TOOL_SERVER_NAME}__`;

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
 * context correctly for a single fresh (non-resumed) query() call. Tool-call/
 * tool-result turns are pre-rendered into this same text form by the
 * translator (spikes/FINDINGS.md's Phase 3 spike — flatten-and-restart is the
 * only reliable way to continue a tool round-trip; resume() permanently
 * poisons a tool_use_id's resolution once denied).
 */
function buildPrompt(messages: InternalMessage[]): string {
  if (messages.length === 1 && messages[0]!.role === 'user') {
    return messages[0]!.content;
  }
  return messages.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n');
}

/**
 * Registers the caller's tools as one ad-hoc MCP server, and denies every
 * call attempt — capturing (name, input, id) and interrupting the query
 * instead of letting the SDK execute anything itself. EXECUTION belongs to
 * whoever the caller is; this gateway only relays the proposal (spikes/
 * FINDINGS.md's Phase 3 spike). The underlying query always ends in an
 * `error_during_execution`-shaped result after this — expected, not a real
 * failure, as long as at least one call was captured.
 */
interface ToolInterception {
  mcpServer: ReturnType<typeof createSdkMcpServer>;
  canUseTool: CanUseTool;
  capturedCalls: InternalToolCall[];
  /** Set to the live Query object once query() returns, so canUseTool can call .interrupt() on it. */
  activeQuery: Query | undefined;
}

// Parallel tool calls (the model calling >1 tool in the same turn) each get
// their own canUseTool invocation, but interrupting on the FIRST one cuts
// the query off before a sibling call's own canUseTool even fires — spike-07
// measured this losing the second (and later) calls outright. Debouncing
// instead — each new capture resets the timer, so interrupt() only actually
// fires once no NEW capture has arrived for a short window — reliably
// captured all calls in 3/3 live runs of a genuine two-tool-call turn.
const PARALLEL_CALL_DEBOUNCE_MS = 50;

function buildToolInterception(tools: InternalToolDefinition[]): ToolInterception {
  const interception: ToolInterception = { mcpServer: undefined as any, canUseTool: undefined as any, capturedCalls: [], activeQuery: undefined };
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  const toolDefs = tools.map((t) =>
    tool(t.name, t.description, jsonSchemaObjectToZodRawShape(t.parameters) as z.ZodRawShape, async () => {
      throw new Error('unreachable — canUseTool always denies before this handler would run');
    })
  );
  interception.mcpServer = createSdkMcpServer({ name: TOOL_SERVER_NAME, tools: toolDefs });

  interception.canUseTool = async (toolName, input, options) => {
    interception.capturedCalls.push({ id: options.toolUseID, name: toolName.startsWith(TOOL_PREFIX) ? toolName.slice(TOOL_PREFIX.length) : toolName, input });
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => void interception.activeQuery?.interrupt(), PARALLEL_CALL_DEBOUNCE_MS);
    return { behavior: 'deny', message: 'Execution deferred to the caller — this gateway only relays tool-call proposals (Phase 3).', toolUseID: options.toolUseID };
  };

  return interception;
}

function buildOptions(request: InternalClaudeRequest, extra: Options = {}): Options {
  // Tool-augmented turns never resume (spikes/FINDINGS.md) — enforced here,
  // not just at the route layer, since it's a hard architectural invariant.
  const resume = request.tools?.length ? undefined : request.resumeSessionId;
  return {
    ...BASE_OPTIONS,
    model: request.model,
    systemPrompt: request.system,
    resume,
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

    const interception = request.tools?.length ? buildToolInterception(request.tools) : undefined;
    const options = buildOptions(request, interception ? { mcpServers: { [TOOL_SERVER_NAME]: interception.mcpServer }, canUseTool: interception.canUseTool } : {});
    const q = query({ prompt, options });
    if (interception) interception.activeQuery = q;

    try {
      for await (const msg of q) {
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
    } catch (err) {
      if (!interception?.capturedCalls.length) throw err;
      // Expected: denying+interrupting a tool call always ends the query in
      // an error-shaped result (spikes/FINDINGS.md) — not a real failure.
    }

    if (interception?.capturedCalls.length) {
      return {
        sessionId: sessionId ?? 'unknown',
        model: actualModel ?? request.model ?? 'unknown',
        text: '',
        toolCalls: interception.capturedCalls,
        stopReason: 'tool_use',
        usage: { inputTokens: 0, outputTokens: 0 },
      };
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
    let toolCallsEmitted = false;

    const interception = request.tools?.length ? buildToolInterception(request.tools) : undefined;
    const options = buildOptions(request, {
      includePartialMessages: true,
      ...(interception ? { mcpServers: { [TOOL_SERVER_NAME]: interception.mcpServer }, canUseTool: interception.canUseTool } : {}),
    });
    const q = query({ prompt, options });
    if (interception) interception.activeQuery = q;

    try {
      for await (const msg of q) {
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
          if (result.is_error && !interception?.capturedCalls.length) {
            throw mapSdkError(undefined, result.subtype);
          }
          if (interception?.capturedCalls.length) {
            toolCallsEmitted = true;
            yield { type: 'tool_calls', toolCalls: interception.capturedCalls };
            yield { type: 'stop', stopReason: 'tool_use', usage: { inputTokens: 0, outputTokens: 0 } };
          } else {
            yield {
              type: 'stop',
              stopReason: result.stop_reason ?? null,
              usage: { inputTokens: result.usage?.input_tokens ?? 0, outputTokens: result.usage?.output_tokens ?? 0 },
            };
          }
        }
      }
    } catch (err) {
      if (!interception?.capturedCalls.length) throw err;
      // Denying+interrupting a tool call always ends the underlying query in
      // an error-shaped result AFTER already yielding its 'result' message
      // (spikes/FINDINGS.md) — don't re-emit if that already happened above.
      if (!toolCallsEmitted) {
        yield { type: 'tool_calls', toolCalls: interception.capturedCalls };
        yield { type: 'stop', stopReason: 'tool_use', usage: { inputTokens: 0, outputTokens: 0 } };
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
