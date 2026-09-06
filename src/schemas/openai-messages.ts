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

const Message = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: Content,
});

export const OpenAiChatCompletionsRequestSchema = z
  .object({
    model: z.string(),
    messages: z.array(Message).min(1),
    // Optional, unlike the Anthropic route — server picks a default when omitted (PRD §6.5).
    max_tokens: z.number().int().positive().optional(),
    temperature: z.number().optional(),
    stream: z.boolean().optional(),
    session_id: z.string().optional(),
  })
  .passthrough()
  .superRefine((body, ctx) => {
    for (const field of ['tools', 'tool_choice', 'functions', 'function_call'] as const) {
      if (field in body) {
        ctx.addIssue({ code: 'custom', path: [field], message: `"${field}" is not supported yet — tool/function-calling is deferred to a later phase (see NG6)` });
      }
    }
  });

export type OpenAiChatCompletionsRequest = z.infer<typeof OpenAiChatCompletionsRequestSchema>;
