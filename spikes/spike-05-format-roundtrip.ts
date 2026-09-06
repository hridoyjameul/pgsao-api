/**
 * Spike 05 — cheap format-roundtrip proof (closes R8/R9 early, before full
 * build-out). A bare `http` server with disposable, hard-coded translator
 * output — the point is shape compatibility, not live inference — hit by the
 * REAL `openai` and `@anthropic-ai/sdk` npm clients via a custom baseURL.
 *
 * Run: npm run spike:05
 */
import http from 'node:http';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { section } from './lib.js';

const PORT = 8799;

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(json);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    await readBody(req);
    return send(res, 200, {
      id: 'chatcmpl-spike-123',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'claude-via-gateway',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Docker networking allows containers to communicate.' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
    });
  }
  if (req.method === 'POST' && req.url === '/v1/messages') {
    await readBody(req);
    return send(res, 200, {
      id: 'msg_spike_123',
      type: 'message',
      role: 'assistant',
      model: 'claude-via-gateway',
      content: [{ type: 'text', text: 'Docker networking allows containers to communicate.' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 8 },
    });
  }
  send(res, 404, { error: 'not found' });
});

async function main() {
  await new Promise<void>((resolve) => server.listen(PORT, resolve));
  console.log(`Spike server listening on http://127.0.0.1:${PORT}`);

  section('Real openai SDK client → /v1/chat/completions');
  const openaiClient = new OpenAI({ apiKey: 'sk-spike-test-key', baseURL: `http://127.0.0.1:${PORT}/v1` });
  const chatCompletion = await openaiClient.chat.completions.create({
    model: 'claude-via-gateway',
    messages: [{ role: 'user', content: 'Explain how Docker networking works.' }],
  });
  console.log('Parsed OK. Content:', chatCompletion.choices[0]?.message?.content);

  section('Real @anthropic-ai/sdk client → /v1/messages');
  const anthropicClient = new Anthropic({ apiKey: 'sk-spike-test-key', baseURL: `http://127.0.0.1:${PORT}` });
  const message = await anthropicClient.messages.create({
    model: 'claude-via-gateway',
    max_tokens: 256,
    messages: [{ role: 'user', content: 'Explain how Docker networking works.' }],
  });
  console.log('Parsed OK. Content:', message.content[0]);

  section('DONE — both real SDK clients redirected via baseURL and parsed hand-built responses without throwing');
  server.close();
}

main().catch((err) => {
  console.error('Spike 05 failed:', err);
  server.close();
  process.exitCode = 1;
});
