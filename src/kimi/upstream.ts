import { ApiError } from '../errors/api-error.js';
import { GATEWAY_VERSION } from '../utils/version.js';
import type { KimiConnection } from './connection.js';

const API_ROOT = 'https://api.kimi.com/coding';

export type KimiPath = '/v1/models' | '/v1/chat/completions' | '/v1/messages';

export const KIMI_MODELS = ['kimi-for-coding', 'kimi-for-coding-highspeed'] as const;

export class KimiUpstream {
  constructor(private readonly connection: KimiConnection, private readonly http: typeof fetch = fetch) {}

  /** Calls Kimi with the saved (or explicitly supplied) key. Client headers are never forwarded. */
  async request(path: KimiPath, method: 'GET' | 'POST', body?: string, opts: { key?: string } = {}): Promise<Response> {
    let key = opts.key;
    if (!key) {
      try { key = await this.connection.getKey(); } catch { throw new ApiError('credential_error', 'Add your Kimi membership key to use this route'); }
    }
    const headers: Record<string, string> = {
      authorization: `Bearer ${key}`,
      'x-api-key': key,
      'user-agent': `PGSAO-API/${GATEWAY_VERSION}`,
      ...(path === '/v1/messages' ? { 'anthropic-version': '2023-06-01' } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    };
    // Abort only while waiting for response headers; long streams must not be cut mid-answer.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    let response: Response;
    try {
      response = await this.http(`${API_ROOT}${path}`, { method, headers, ...(body === undefined ? {} : { body }), redirect: 'error', signal: controller.signal });
    } catch { throw new ApiError('provider_error', 'Kimi is unavailable'); }
    finally { clearTimeout(timer); }
    if (response.ok) return response;
    await response.body?.cancel().catch(() => {});
    if (response.status === 401 || response.status === 403) throw new ApiError('credential_error', 'Kimi rejected the membership key; enter a new key');
    if (response.status === 429) {
      const retry = Number(response.headers.get('retry-after'));
      const retryAfterSeconds = Number.isFinite(retry) && retry > 0 ? Math.min(retry, 3600) : undefined;
      this.connection.noteLimit(retryAfterSeconds);
      throw new ApiError('usage_limit_error', 'Kimi membership usage limit reached', retryAfterSeconds ? { retryAfterSeconds } : {});
    }
    if ([400, 404, 405, 413, 422].includes(response.status)) throw new ApiError('invalid_request_error', 'Kimi rejected the request', { code: String(response.status) });
    throw new ApiError('provider_error', 'Kimi upstream error');
  }
}
