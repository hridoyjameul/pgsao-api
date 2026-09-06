import type { ClaudeProvider, CredentialStatus, InternalClaudeEvent, InternalClaudeRequest, InternalClaudeResponse } from '../../src/providers/types.js';

/**
 * Deterministic, free, fast test double for ClaudeProvider. Proves the full
 * HTTP/schema/translator/SSE pipeline against the REAL `openai` and
 * `@anthropic-ai/sdk` client libraries (fidelity to their parsing/error
 * expectations) without spending real Claude usage on every `npm test` run.
 * A live-account smoke test remains the true end-to-end proof — see
 * README.md's quickstart walkthrough (mirrors PRD §21).
 */
export class FakeClaudeProvider implements ClaudeProvider {
  public lastRequest?: InternalClaudeRequest;
  public credentialStatus: CredentialStatus = { ok: true, email: 'test@example.com', organization: 'Test Org', subscriptionType: 'Claude API' };
  public responseText = 'Docker networking allows containers to communicate.';
  public sessionCounter = 0;
  /** Artificial latency, for deterministically testing the concurrency queue without waiting on real Claude latency. */
  public delayMs = 0;
  private readonly sessionSecrets = new Map<string, string>();

  async sendMessage(request: InternalClaudeRequest): Promise<InternalClaudeResponse> {
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    this.lastRequest = request;
    const sessionId = request.resumeSessionId ?? `fake-session-${++this.sessionCounter}`;

    // Phase 3 (Phase 3/NG6) tool-calling simulation: if the caller declared
    // tools and the flattened history doesn't yet contain a tool result,
    // "decide" to call the first declared tool — mirroring the real
    // propose/continue round trip (spikes/FINDINGS.md's Phase 3 spike)
    // without spending real Claude usage.
    if (request.tools?.length) {
      const flattenedAll = request.messages.map((m) => m.content).join('\n');
      const toolResultMatch = flattenedAll.match(/\[tool result for tool_use_id [^\]]*?:\s*([\s\S]*?)\]/);
      if (!toolResultMatch) {
        const t = request.tools[0]!;
        return {
          sessionId,
          model: request.model ?? 'claude-sonnet-5',
          text: '',
          toolCalls: [{ id: 'fake_tool_call_1', name: t.name, input: {} }],
          stopReason: 'tool_use',
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      }
      return {
        sessionId,
        model: request.model ?? 'claude-sonnet-5',
        text: `Tool result received: ${toolResultMatch[1]!.trim()}`,
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 8 },
      };
    }

    // Minimal "memory" so session-isolation tests can verify resume behavior
    // without a live Claude account: remember the last user message per
    // session id, and echo it back when asked "what did I just say?". The
    // recall question itself contains the word "remember", so check for it
    // FIRST and treat the two as mutually exclusive — otherwise the question
    // "What did I ask you to remember?" would overwrite, then immediately
    // recall, itself.
    const lastUserMessage = [...request.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const isRecallQuestion = /what.*(secret|say|remember)/i.test(lastUserMessage);
    const recall = isRecallQuestion ? (this.sessionSecrets.get(sessionId) ?? 'nothing') : undefined;
    if (!isRecallQuestion && /remember/i.test(lastUserMessage)) {
      this.sessionSecrets.set(sessionId, lastUserMessage);
    }

    return {
      sessionId,
      model: request.model ?? 'claude-sonnet-5',
      text: recall ?? this.responseText,
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 8 },
    };
  }

  async *streamMessage(request: InternalClaudeRequest): AsyncIterable<InternalClaudeEvent> {
    const response = await this.sendMessage(request);
    yield { type: 'start', sessionId: response.sessionId, model: response.model };
    if (response.toolCalls?.length) {
      yield { type: 'tool_calls', toolCalls: response.toolCalls };
    } else {
      for (const word of response.text.split(' ')) {
        yield { type: 'text_delta', text: word + ' ' };
      }
    }
    yield { type: 'stop', stopReason: response.stopReason, usage: response.usage };
  }

  async checkCredentials(): Promise<CredentialStatus> {
    return this.credentialStatus;
  }
}
