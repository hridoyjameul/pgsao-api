export interface InternalMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface InternalClaudeRequest {
  /** Resolved internal model id (post alias lookup). Undefined => let the Agent SDK use its own configured default model. */
  model: string | undefined;
  system?: string;
  /** Full conversation, oldest first. On the resume path this is only the NEW trailing turn(s) — see providers/claude.ts. */
  messages: InternalMessage[];
  maxTokens?: number;
  stream: boolean;
  /** Agent SDK session id to resume. Undefined => stateless fresh call (PRD §1.5 default mode). */
  resumeSessionId?: string;
}

export interface InternalClaudeResponse {
  /** Agent SDK session id this call ran under (new or resumed) — used to persist the session_id extension mapping. */
  sessionId: string;
  /** Actual model that produced the response, as reported by the SDK. */
  model: string;
  text: string;
  /** Raw Anthropic-vocabulary stop reason ('end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | ... | null) — the SDK's native vocabulary; each translator maps it into its own route's enum. */
  stopReason: string | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

/** Normalized streaming event — translators reconstruct their own route's SSE shape from this. */
export type InternalClaudeEvent =
  | { type: 'start'; sessionId: string; model: string }
  | { type: 'text_delta'; text: string }
  | { type: 'stop'; stopReason: string | null; usage: { inputTokens: number; outputTokens: number } };

export type CredentialStatus =
  | { ok: true; email?: string; organization?: string; subscriptionType?: string }
  | { ok: false; message: string };

export interface ClaudeProvider {
  sendMessage(request: InternalClaudeRequest): Promise<InternalClaudeResponse>;
  streamMessage(request: InternalClaudeRequest): AsyncIterable<InternalClaudeEvent>;
  checkCredentials(): Promise<CredentialStatus>;
}
