import { z } from 'zod';

const TextBlock = z.object({ type: z.literal('text'), text: z.string() });
const ToolUseBlock = z.object({ type: z.literal('tool_use'), id: z.string(), name: z.string(), input: z.record(z.string(), z.unknown()) });
const ToolResultContent = z.union([z.string(), z.array(TextBlock)]);
const ToolResultBlock = z.object({ type: z.literal('tool_result'), tool_use_id: z.string(), content: ToolResultContent.optional(), is_error: z.boolean().optional() });

// MVP is text-only aside from tool_use/tool_result (PRD NG4, Phase 3/NG6) —
// any other content block type (image, ...) is rejected explicitly rather
// than silently dropped, matching R9's "unsupported fields fail clearly".
const Content = z.union([
  z.string(),
  z
    .array(z.union([TextBlock, ToolUseBlock, ToolResultBlock, z.object({ type: z.string() })]))
    .transform((blocks, ctx) => {
      for (const b of blocks) {
        if (b.type !== 'text' && b.type !== 'tool_use' && b.type !== 'tool_result') {
          ctx.addIssue({ code: 'custom', message: `Unsupported content block type "${b.type}" — this MVP only supports text/tool_use/tool_result content blocks` });
          return z.NEVER;
        }
      }
      return blocks as Array<z.infer<typeof TextBlock> | z.infer<typeof ToolUseBlock> | z.infer<typeof ToolResultBlock>>;
    }),
]);

const Message = z.object({
  role: z.enum(['user', 'assistant']),
  content: Content,
});

const ToolDefinition = z.object({
  name: z.string(),
  description: z.string().optional().default(''),
  input_schema: z.record(z.string(), z.unknown()),
});

// Only 'auto' (default — model decides) and 'none' (no tool calls this turn)
// are supported; forcing a specific tool ({type:'tool',name}) or {type:'any'}
// has no equivalent Agent SDK option and is rejected explicitly rather than
// silently ignored (R9) — see spikes/FINDINGS.md's Phase 3 spike. `type`
// accepts any string here so the superRefine below can give a specific
// error message rather than a generic enum-mismatch one.
const ToolChoice = z.object({ type: z.string() }).passthrough();

export const AnthropicMessagesRequestSchema = z
  .object({
    model: z.string(),
    max_tokens: z.number().int().positive({ message: 'max_tokens is required' }),
    system: z.string().optional(),
    messages: z.array(Message).min(1),
    stream: z.boolean().optional(),
    session_id: z.string().optional(),
    tools: z.array(ToolDefinition).optional(),
    tool_choice: ToolChoice.optional(),
  })
  .passthrough()
  .superRefine((body, ctx) => {
    if (body.tool_choice && !['auto', 'none'].includes(body.tool_choice.type)) {
      ctx.addIssue({ code: 'custom', path: ['tool_choice'], message: `tool_choice.type "${body.tool_choice.type}" is not supported yet — only "auto" and "none" are (see NG6)` });
    }
  });

export type AnthropicMessagesRequest = z.infer<typeof AnthropicMessagesRequestSchema>;
