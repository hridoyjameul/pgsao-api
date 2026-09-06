import { z } from 'zod';

const TextPart = z.object({ type: z.literal('text'), text: z.string() });

// MVP is text-only (PRD NG4/NG6) — non-text parts (image_url, ...) rejected
// explicitly rather than silently dropped, matching R9.
const Content = z.union([
  z.string(),
  z.array(TextPart.or(z.object({ type: z.string() }))).transform((parts, ctx) => {
    for (const p of parts) {
      if (p.type !== 'text') {
        ctx.addIssue({ code: 'custom', message: `Unsupported content part type "${p.type}" — this MVP only supports text content parts` });
        return z.NEVER;
      }
    }
    return parts as z.infer<typeof TextPart>[];
  }),
]);

const ToolCall = z.object({
  id: z.string(),
  type: z.literal('function'),
  function: z.object({ name: z.string(), arguments: z.string() }),
});

const Message = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: Content.nullish(),
  // Present on an assistant message that decided to call tool(s) (Phase 3/NG6).
  tool_calls: z.array(ToolCall).optional(),
  // Present on a role:"tool" message — the caller's result for that tool_call_id.
  tool_call_id: z.string().optional(),
});

const FunctionToolDefinition = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string(),
    description: z.string().optional().default(''),
    parameters: z.record(z.string(), z.unknown()).optional().default({}),
  }),
});

// Only 'auto' (default) and 'none' are supported; 'required' or forcing a
// specific named function has no equivalent Agent SDK option and is rejected
// explicitly (R9) — see spikes/FINDINGS.md's Phase 3 spike. Accepts any
// shape here so the superRefine below can give a specific error message
// rather than a generic union-mismatch one.
const ToolChoice = z.union([z.string(), z.object({ type: z.literal('function'), function: z.object({ name: z.string() }) }).passthrough()]);

export const OpenAiChatCompletionsRequestSchema = z
  .object({
    model: z.string(),
    messages: z.array(Message).min(1),
    // Optional, unlike the Anthropic route — server picks a default when omitted (PRD §6.5).
    max_tokens: z.number().int().positive().optional(),
    temperature: z.number().optional(),
    stream: z.boolean().optional(),
    session_id: z.string().optional(),
    tools: z.array(FunctionToolDefinition).optional(),
    tool_choice: ToolChoice.optional(),
  })
  .passthrough()
  .superRefine((body, ctx) => {
    if ('functions' in body || 'function_call' in body) {
      ctx.addIssue({ code: 'custom', message: '"functions"/"function_call" (the deprecated OpenAI convention) are not supported — use "tools"/"tool_choice" instead' });
    }
    if (body.tool_choice !== undefined && body.tool_choice !== 'auto' && body.tool_choice !== 'none') {
      const described = typeof body.tool_choice === 'string' ? `"${body.tool_choice}"` : 'a forced named tool';
      ctx.addIssue({ code: 'custom', path: ['tool_choice'], message: `tool_choice ${described} is not supported yet — only "auto" and "none" are (see NG6)` });
    }
  });

export type OpenAiChatCompletionsRequest = z.infer<typeof OpenAiChatCompletionsRequestSchema>;
