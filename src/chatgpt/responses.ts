import { z } from 'zod';
import type { ServerResponse } from 'node:http';
import { once } from 'node:events';
import { ApiError } from '../errors/api-error.js';

export const ChatGptResponsesRequestSchema = z.strictObject({
  model: z.string().min(1),
  input: z.array(z.strictObject({ role: z.enum(['user', 'assistant', 'developer']), content: z.string().min(1) })).min(1),
  instructions: z.string().optional(),
  store: z.literal(false),
  stream: z.literal(true),
});

async function writeFrame(reply: ServerResponse, frame: string): Promise<void> {
  if (!reply.write(`${frame}\n\n`)) await once(reply, 'drain');
}

/** Forward well-formed SSE, but do not call an interrupted or failed stream a success. */
export async function forwardChatGptSse(response: Response, reply: ServerResponse): Promise<void> {
  if (!response.body || !response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
    throw new ApiError('provider_error', 'Invalid ChatGPT stream');
  }
  reply.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let completed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      if (buffer.length > 1_048_576) throw new ApiError('provider_error', 'ChatGPT stream frame too large');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (!frame.trim()) continue;
        const lines = frame.split('\n');
        const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim();
        const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
        if (!data) throw new ApiError('provider_error', 'Malformed ChatGPT stream');
        if (data === '[DONE]') {
          if (!completed) throw new ApiError('provider_error', 'ChatGPT stream ended before completion');
          await writeFrame(reply, frame);
          continue;
        }
        let payload: unknown;
        try { payload = JSON.parse(data); } catch { throw new ApiError('provider_error', 'Malformed ChatGPT stream'); }
        const type = payload && typeof payload === 'object' ? (payload as Record<string, unknown>).type : undefined;
        if (typeof type !== 'string' || (event && event !== type)) throw new ApiError('provider_error', 'Malformed ChatGPT stream');
        await writeFrame(reply, frame);
        if (type === 'response.failed' || type === 'response.incomplete') throw new ApiError('provider_error', 'ChatGPT response did not complete');
        if (type === 'response.completed') completed = true;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim() || !completed) throw new ApiError('provider_error', 'ChatGPT stream ended before completion');
  } finally { reader.releaseLock(); }
}
