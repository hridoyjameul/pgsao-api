import { z } from 'zod';

const TextBlock = z.object({ type: z.literal('text'), text: z.string() });

// MVP is text-only (PRD NG4/NG6) — any other content block type (image,
// tool_use, tool_result, ...) is rejected explicitly rather than silently
// dropped, matching R9's "unsupported fields fail clearly" mitigation.
const Content = z.union([
  z.string(),
  z.array(TextBlock.or(z.object({ type: z.string() }))).transform((blocks, ctx) => {
    for (const b of blocks) {
      if (b.type !== 'text') {
        ctx.addIssue({ code: 'custom', message: `Unsupported content block type "${b.type}" — this MVP only supports text content blocks` });
        return z.NEVER;
      }
    }
    return blocks as z.infer<typeof TextBlock>[];
  }),
]);

const Message = z.object({
  role: z.enum(['user', 'assistant']),
  content: Content,
});

export const AnthropicMessagesRequestSchema = z
  .object({
    model: z.string(),
    max_tokens: z.number().int().positive({ message: 'max_tokens is required' }),
    system: z.string().optional(),
    messages: z.array(Message).min(1),
    stream: z.boolean().optional(),
    session_id: z.string().optional(),
  })
  .passthrough()
  .superRefine((body, ctx) => {
    for (const field of ['tools', 'tool_choice'] as const) {
      if (field in body) {
        ctx.addIssue({ code: 'custom', path: [field], message: `"${field}" is not supported yet — tool/function-calling is deferred to a later phase (see NG6)` });
      }
    }
  });

export type AnthropicMessagesRequest = z.infer<typeof AnthropicMessagesRequestSchema>;
