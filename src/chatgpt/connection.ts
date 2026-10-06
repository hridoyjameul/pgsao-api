import type { ProviderStatus } from '../providers/registry.js';
import type { ChatGptAccount, ChatGptCredentialStore } from './credential-store.js';
import { CHATGPT_RESOURCE, type OAuthFetch } from './oauth.js';

const ISSUER = 'https://auth.openai.com';
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;

export class ChatGptConnection {
  private refreshing?: { registrationId: string; promise: Promise<string> };
  private disconnecting = false;

  constructor(private readonly store: ChatGptCredentialStore, private readonly http: OAuthFetch = fetch) {}

  async status(): Promise<ProviderStatus['connection']> {
    const state = await this.store.load();
    const account = state.accounts.find((item) => item.registrationId === state.selectedRegistrationId);
    const registrations = state.accounts.map((item) => ({ registrationId: item.registrationId, label: item.email || `ChatGPT account ${item.registrationId.slice(0, 8)}`, selected: item.registrationId === state.selectedRegistrationId }));
    if (!account) return { state: 'not_configured', registrations };
    return account.accessToken && account.refreshToken
      ? { state: 'connected', detail: account.email || 'ChatGPT account connected', registrations }
      : { state: 'disconnected', detail: account.email || 'Reconnect ChatGPT', registrations };
  }

  async getAccessToken(): Promise<string> {
    if (this.disconnecting) throw new Error('Reconnect ChatGPT');
    const state = await this.store.load();
    const account = state.accounts.find((item) => item.registrationId === state.selectedRegistrationId);
    if (!account?.accessToken || !account.refreshToken) throw new Error('Reconnect ChatGPT');
    if (account.expiresAt > Date.now() + 60_000) return account.accessToken;
    if (this.refreshing?.registrationId === account.registrationId) {
      const token = await this.refreshing.promise;
      if (this.disconnecting) throw new Error('Reconnect ChatGPT');
      return token;
    }
    const promise = this.refresh(account);
    this.refreshing = { registrationId: account.registrationId, promise };
    try {
      const token = await promise;
      if (this.disconnecting) throw new Error('Reconnect ChatGPT');
      return token;
    } finally { if (this.refreshing?.promise === promise) this.refreshing = undefined; }
  }

  private async refresh(account: ChatGptAccount): Promise<string> {
    const form = new URLSearchParams({ grant_type: 'refresh_token', client_id: account.clientId, refresh_token: account.refreshToken, resource: CHATGPT_RESOURCE });
    let response: Response;
    try {
      response = await this.http(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form, redirect: 'error', signal: AbortSignal.timeout(15_000) });
    } catch { throw new Error('ChatGPT token refresh unavailable'); }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      if (response.status === 400 && body.length < 16_000 && /"invalid_grant"/.test(body)) {
        await this.clearAccount(account.registrationId, account.refreshToken);
        throw new Error('Reconnect ChatGPT');
      }
      throw new Error('ChatGPT token refresh unavailable');
    }
    const raw = await response.text();
    if (raw.length > 256_000) throw new Error('Invalid ChatGPT token refresh');
    let tokens: Record<string, unknown>;
    try { tokens = JSON.parse(raw) as Record<string, unknown>; } catch { throw new Error('Invalid ChatGPT token refresh'); }
    if (typeof tokens.access_token !== 'string' || typeof tokens.refresh_token !== 'string'
      || typeof tokens.expires_in !== 'number' || tokens.expires_in <= 0) throw new Error('Invalid ChatGPT token refresh');
    if (typeof tokens.scope === 'string' && !tokens.scope.split(/\s+/).includes('chatgpt.tokens.use.direct')) {
      await this.clearAccount(account.registrationId, account.refreshToken);
      throw new Error('Reconnect ChatGPT');
    }
    return this.store.update((state) => {
      const current = state.accounts.find((item) => item.registrationId === account.registrationId);
      if (!current || current.refreshToken !== account.refreshToken) throw new Error('Reconnect ChatGPT');
      current.accessToken = tokens.access_token as string;
      current.refreshToken = tokens.refresh_token as string;
      if (typeof tokens.id_token === 'string') current.idToken = tokens.id_token;
      if (typeof tokens.scope === 'string') current.scopes = tokens.scope.split(/\s+/).filter(Boolean);
      current.expiresAt = Date.now() + (tokens.expires_in as number) * 1000;
      return current.accessToken;
    });
  }

  private async clearAccount(registrationId: string, expectedRefreshToken?: string): Promise<void> {
    await this.store.update((state) => {
      const account = state.accounts.find((item) => item.registrationId === registrationId);
      if (!account || (expectedRefreshToken && account.refreshToken !== expectedRefreshToken)) return;
      account.accessToken = '';
      account.refreshToken = '';
      account.idToken = '';
      account.expiresAt = 0;
    });
  }

  async disconnect(): Promise<{ remoteRevocationConfirmed: boolean }> {
    this.disconnecting = true;
    try {
      await this.refreshing?.promise.catch(() => {});
      const state = await this.store.load();
      const account = state.accounts.find((item) => item.registrationId === state.selectedRegistrationId);
      if (!account?.refreshToken) return { remoteRevocationConfirmed: true };
      let confirmed = false;
      for (let attempt = 0; attempt < 3 && !confirmed; attempt++) {
        try {
          const discoveryResponse = await this.http(DISCOVERY_URL, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
          if (!discoveryResponse.ok) throw new Error('Discovery failed');
          const raw = await discoveryResponse.text();
          if (raw.length > 256_000) throw new Error('Discovery too large');
          const discovery = JSON.parse(raw) as Record<string, unknown>;
          if (typeof discovery.revocation_endpoint !== 'string') break;
          const url = new URL(discovery.revocation_endpoint);
          if (url.origin !== ISSUER || url.protocol !== 'https:') break;
          const form = new URLSearchParams({ token: account.refreshToken, token_type_hint: 'refresh_token', client_id: account.clientId });
          const result = await this.http(url.toString(), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form, redirect: 'error', signal: AbortSignal.timeout(10_000) });
          if (result.status === 200) confirmed = true;
          else if (result.status < 500) break;
        } catch { /* retry bounded network failures */ }
        if (!confirmed && attempt < 2) await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
      }
      await this.clearAccount(account.registrationId, account.refreshToken);
      return { remoteRevocationConfirmed: confirmed };
    } finally { this.disconnecting = false; }
  }
}
