import type { FastifyInstance } from 'fastify';
import type { GatewayDeps } from '../app.js';

export type ProviderId = 'claude' | 'chatgpt' | 'gemini' | 'kimi' | 'qwen';
export type ProviderCapability = {
  shape: 'openai_chat' | 'anthropic_messages' | 'openai_responses';
  basePath: string;
  legacy?: boolean;
};
export type ProviderStatus = {
  id: ProviderId;
  displayName: string;
  client: { state: 'detected' | 'not_detected' | 'not_required'; method: string };
  connection: { state: 'connected' | 'disconnected' | 'not_configured'; detail?: string; registrations?: Array<{ registrationId: string; label: string; selected: boolean }> };
  api: { ready: boolean; capabilities: ProviderCapability[] };
  setupAction: 'none' | 'sign_in' | 'enter_key' | 'install_cli' | 'reconnect' | 'enable_route' | 'coming_soon';
};

export interface ProviderAdapter {
  id: ProviderId;
  displayName: string;
  connectionMethod: 'existing_session' | 'oauth' | 'cli_login' | 'vendor_key';
  detectClient(): Promise<ProviderStatus['client']>;
  getConnection(): Promise<ProviderStatus['connection']>;
  capabilities: readonly ProviderCapability[];
  listModels?(): Promise<{ id: string; displayName?: string }[]>;
  registerRoutes(app: FastifyInstance, gateway: GatewayDeps): void;
}

const ORDER: readonly ProviderId[] = ['claude', 'chatgpt', 'gemini', 'kimi', 'qwen'];

export class ProviderRegistry {
  private readonly adapters = new Map<ProviderId, ProviderAdapter>();

  register(adapter: ProviderAdapter): void {
    if (this.adapters.has(adapter.id)) throw new Error(`Duplicate provider adapter: ${adapter.id}`);
    this.adapters.set(adapter.id, adapter);
  }

  async listStatuses(): Promise<ProviderStatus[]> {
    return Promise.all(ORDER.filter((id) => this.adapters.has(id)).map(async (id) => {
      const adapter = this.adapters.get(id)!;
      const [client, connection] = await Promise.all([adapter.detectClient(), adapter.getConnection()]);
      const capabilities = connection.state === 'connected' ? [...adapter.capabilities] : [];
      const ready = capabilities.length > 0;
      const setupAction: ProviderStatus['setupAction'] = ready ? 'none'
        : adapter.id === 'claude' && adapter.capabilities.length === 0 ? 'enable_route'
          : adapter.capabilities.length === 0 ? 'coming_soon'
          : connection.state === 'disconnected' ? 'reconnect'
            : adapter.connectionMethod === 'vendor_key' ? 'enter_key'
              : adapter.connectionMethod === 'oauth' ? 'sign_in'
                : client.state === 'not_detected' ? 'install_cli' : 'reconnect';
      return { id, displayName: adapter.displayName, client, connection, api: { ready, capabilities }, setupAction };
    }));
  }

  registerRoutes(app: FastifyInstance, gateway: GatewayDeps): void {
    for (const id of ORDER) this.adapters.get(id)?.registerRoutes(app, gateway);
  }
}
