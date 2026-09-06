import type { JsonSchemaObject } from '../utils/json-schema-to-zod.js';

export interface InternalMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** A tool the caller declared (PRD §23/NG6, Phase 3). Shape-agnostic — translators convert OpenAI `function`/Anthropic `input_schema` shapes into this. */
export interface InternalToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchemaObject;
}

export interface InternalClaudeRequest {
  /** Resolved internal model id (post alias lookup). Undefined => let the Agent SDK use its own configured default model. */
  model: string | undefined;
  system?: string;
  /** Full conversation, oldest first. On the resume path this is only the NEW trailing turn(s) — see providers/claude.ts. Tool-call/tool-result turns are pre-flattened into descriptive text by the translator (spikes/FINDINGS.md's Phase 3 spike). */
  messages: InternalMessage[];
  maxTokens?: number;
  stream: boolean;
  /** Agent SDK session id to resume. Undefined => stateless fresh call (PRD §1.5 default mode). Always undefined when `tools` is set — see providers/claude.ts. */
  resumeSessionId?: string;
  /** Tools the caller declared. When present, forces the flatten-and-restart path — never resumed (spikes/FINDINGS.md: resume() poisons a tool_use_id's resolution permanently once denied). */
  tools?: InternalToolDefinition[];
}

/** A tool the model wants to call — the caller executes it and reports back via a fresh (non-resumed) follow-up call. */
export interface InternalToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface InternalClaudeResponse {
  /** Agent SDK session id this call ran under (new or resumed) — used to persist the session_id extension mapping. */
  sessionId: string;
  /** Actual model that produced the response, as reported by the SDK. */
  model: string;
  text: string;
  /** Present when the model wants to call one or more tools instead of (or before) answering — stopReason is 'tool_use' when this is set. */
  toolCalls?: InternalToolCall[];
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
  | { type: 'tool_calls'; toolCalls: InternalToolCall[] }
  | { type: 'stop'; stopReason: string | null; usage: { inputTokens: number; outputTokens: number } };

export type CredentialStatus =
  | { ok: true; email?: string; organization?: string; subscriptionType?: string }
  | { ok: false; message: string };

export interface ClaudeProvider {
  sendMessage(request: InternalClaudeRequest): Promise<InternalClaudeResponse>;
  streamMessage(request: InternalClaudeRequest): AsyncIterable<InternalClaudeEvent>;
  checkCredentials(): Promise<CredentialStatus>;
}
