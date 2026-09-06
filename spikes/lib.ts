import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

export function logMessage(label: string, message: SDKMessage): void {
  const { type } = message;
  if (type === 'assistant') {
    const blocks = (message as any).message?.content ?? [];
    const kinds = blocks.map((b: any) => b.type).join(',');
    console.log(`[${label}] assistant message (blocks: ${kinds || 'none'})`);
  } else if (type === 'result') {
    console.log(`[${label}] result:`, JSON.stringify(message, null, 2));
  } else if (type === 'system') {
    const sub = (message as any).subtype;
    console.log(`[${label}] system/${sub} session_id=${(message as any).session_id ?? 'n/a'}`);
  } else if (type === 'user') {
    console.log(`[${label}] user message echoed back`);
  } else {
    console.log(`[${label}] ${type}`);
  }
}

export function extractFinalText(messages: SDKMessage[]): string | undefined {
  const result = messages.find((m) => m.type === 'result') as any;
  if (result?.subtype === 'success') return result.result as string;
  return undefined;
}

export function extractSessionId(messages: SDKMessage[]): string | undefined {
  const sys = messages.find((m) => m.type === 'system' && (m as any).subtype === 'init') as any;
  return sys?.session_id;
}

export function section(title: string): void {
  console.log('\n' + '='.repeat(8) + ' ' + title + ' ' + '='.repeat(8));
}
