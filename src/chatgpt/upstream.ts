import { ApiError } from '../errors/api-error.js';
import type { ChatGptConnection } from './connection.js';
import type { OAuthFetch } from './oauth.js';

const API_ROOT = 'https://api.openai.com/v1';

export class ChatGptUpstream {
  constructor(private readonly connection: ChatGptConnection, private readonly http: OAuthFetch = fetch) {}

  private async accessToken(accountId?: string): Promise<{ registrationId: string; token: string }> {
    try { return await this.connection.getAccessToken(accountId); }
    catch { throw new ApiError('credential_error', accountId ? 'Reconnect the ChatGPT account this API key uses, or pick another account for the key' : 'Connect ChatGPT to use this route'); }
  }

  /** Uses the active account, or `accountId` when the caller's API key is pinned to one. */
  async request(path: '/models' | '/responses', method: 'GET' | 'POST', body?: string, accountId?: string): Promise<Response> {
    const { registrationId, token } = await this.accessToken(accountId);
    let response: Response;
    try {
      response = await this.http(`${API_ROOT}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body }),
        redirect: 'error', signal: AbortSignal.timeout(120_000),
      });
    } catch { throw new ApiError('provider_error', 'ChatGPT is unavailable'); }
    if (response.status === 401 || response.status === 403) throw new ApiError('credential_error', 'Reconnect ChatGPT');
    if (response.status === 429) {
      const retry = Number(response.headers.get('retry-after'));
      const retryAfterSeconds = Number.isFinite(retry) && retry > 0 ? Math.min(retry, 3600) : undefined;
      this.connection.noteLimit(registrationId, retryAfterSeconds);
      const plan = await this.connection.planLabel(registrationId);
      throw new ApiError('usage_limit_error', `ChatGPT${plan ? ` ${plan} plan` : ''} usage limit reached`, retryAfterSeconds ? { retryAfterSeconds } : {});
    }
    if (!response.ok) throw new ApiError('provider_error', 'ChatGPT upstream error');
    return response;
  }

  async listModels(accountId?: string): Promise<{ models: Array<{ slug: string; display_name: string }> }> {
    const response = await this.request('/models', 'GET', undefined, accountId);
    const text = await response.text();
    if (text.length > 2_000_000) throw new ApiError('provider_error', 'ChatGPT model catalog too large');
    let data: unknown;
    try { data = JSON.parse(text); } catch { throw new ApiError('provider_error', 'Invalid ChatGPT model catalog'); }
    if (!data || typeof data !== 'object' || !Array.isArray((data as { models?: unknown }).models)) {
      throw new ApiError('provider_error', 'Invalid ChatGPT model catalog');
    }
    const models = (data as { models: unknown[] }).models.filter((model): model is { slug: string; display_name: string; visibility: string } => {
      if (!model || typeof model !== 'object') return false;
      const item = model as Record<string, unknown>;
      return item.visibility === 'list' && typeof item.slug === 'string' && typeof item.display_name === 'string';
    }).map(({ slug, display_name }) => ({ slug, display_name }));
    return { models };
  }
}
