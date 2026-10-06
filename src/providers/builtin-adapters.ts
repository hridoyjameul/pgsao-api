import type { Config } from '../config/config.js';
import type { CredentialMonitor } from '../auth/credential-monitor.js';
import { listModelAliases } from '../config/models.js';
import { detectExecutable } from './detect-client.js';
import type { ProviderAdapter, ProviderId, ProviderStatus } from './registry.js';

type Detector = typeof detectExecutable;

export function createBuiltinAdapters(credentialMonitor: CredentialMonitor, config: Config, detector: Detector = detectExecutable): ProviderAdapter[] {
  const detected = (name: string): ProviderStatus['client'] => ({
    state: detector(name) ? 'detected' : 'not_detected', method: `${name} on PATH`,
  });
  const pending = (id: ProviderId, displayName: string, command: string | null, connectionMethod: ProviderAdapter['connectionMethod']): ProviderAdapter => ({
    id, displayName, connectionMethod,
    detectClient: async () => command ? detected(command) : { state: 'not_required', method: 'Direct account connection' },
    getConnection: async () => ({ state: 'not_configured' }),
    capabilities: [],
    registerRoutes: () => {},
  });

  const claude: ProviderAdapter = {
    id: 'claude', displayName: 'Claude', connectionMethod: 'existing_session',
    detectClient: async () => detected('claude'),
    getConnection: async () => credentialMonitor.status.ok
      ? { state: 'connected', detail: credentialMonitor.status.subscriptionType }
      : { state: 'disconnected', detail: credentialMonitor.status.message },
    capabilities: [
      ...(config.ENABLE_OPENAI_COMPAT_ROUTE ? [{ shape: 'openai_chat' as const, basePath: '/v1', legacy: true }] : []),
      ...(config.ENABLE_ANTHROPIC_COMPAT_ROUTE ? [{ shape: 'anthropic_messages' as const, basePath: '/', legacy: true }] : []),
    ],
    listModels: async () => listModelAliases().map((id) => ({ id })),
    registerRoutes: () => {},
  };
  return [claude,
    pending('chatgpt', 'ChatGPT', null, 'oauth'),
    pending('gemini', 'Gemini', 'gemini', 'cli_login'),
    pending('kimi', 'Kimi', 'kimi', 'vendor_key'),
    pending('qwen', 'Qwen', 'qwen', 'vendor_key')];
}
