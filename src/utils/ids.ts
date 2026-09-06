import { randomBytes } from 'node:crypto';

function shortId(): string {
  return randomBytes(12).toString('hex');
}

/** Matches the example id formats in PRD §8. */
export const generateChatCompletionId = () => `chatcmpl-local-${shortId()}`;
export const generateMessageId = () => `msg_local_${shortId()}`;
export const generateRequestId = () => `req_${shortId()}`;
