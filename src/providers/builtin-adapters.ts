import type { Config } from '../config/config.js';
import type { CredentialMonitor } from '../auth/credential-monitor.js';
import { listModelAliases } from '../config/models.js';
import { detectExecutable } from './detect-client.js';
import type { ProviderAdapter, ProviderId, ProviderStatus } from './registry.js';
import { registerModelsRoute } from '../routes/models.js';
import { registerAnthropicCompatRoute } from '../routes/anthropic-compat.js';
import { registerOpenAiCompatRoute } from '../routes/openai-compat.js';
import type { ChatGptConnection } from '../chatgpt/connection.js';
import { registerChatGptModelsRoute } from '../routes/chatgpt-models.js';
import { registerChatGptResponsesRoute } from '../routes/chatgpt-responses.js';
import type { KimiConnection } from '../kimi/connection.js';
import { registerKimiRoutes } from '../routes/kimi.js';

type Detector = typeof detectExecutable;

export function createBuiltinAdapters(credentialMonitor: CredentialMonitor, config: Config, chatGptConnection: ChatGptConnection, kimiConnection: KimiConnection, detector: Detector = detectExecutable): ProviderAdapter[] {
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
      ...(config.ENABLE_OPENAI_COMPAT_ROUTE ? [{ shape: 'openai_chat' as const, basePath: '/claude/v1' }] : []),
      ...(config.ENABLE_ANTHROPIC_COMPAT_ROUTE ? [{ shape: 'anthropic_messages' as const, basePath: '/claude' }] : []),
    ],
    listModels: async () => listModelAliases().map((id) => ({ id })),
    registerRoutes: (app, gateway) => {
      registerModelsRoute(app, gateway, ['/v1/models', '/claude/v1/models']);
      if (config.ENABLE_ANTHROPIC_COMPAT_ROUTE) registerAnthropicCompatRoute(app, gateway, ['/v1/messages', '/claude/v1/messages']);
      if (config.ENABLE_OPENAI_COMPAT_ROUTE) registerOpenAiCompatRoute(app, gateway, ['/v1/chat/completions', '/claude/v1/chat/completions']);
    },
  };
  const chatgpt: ProviderAdapter = {
    id: 'chatgpt', displayName: 'ChatGPT', connectionMethod: 'oauth',
    detectClient: async () => ({ state: 'not_required', method: 'Direct account connection' }),
    getConnection: () => chatGptConnection.status(),
    capabilities: [{ shape: 'openai_responses', basePath: '/chatgpt/v1' }],
    registerRoutes: (app, gateway) => {
      registerChatGptModelsRoute(app, gateway);
      registerChatGptResponsesRoute(app, gateway);
    },
  };
  const kimi: ProviderAdapter = {
    id: 'kimi', displayName: 'Kimi', connectionMethod: 'vendor_key',
    detectClient: async () => ({ state: 'not_required', method: 'Kimi Code membership API key' }),
    getConnection: () => kimiConnection.status(),
    capabilities: [{ shape: 'openai_chat', basePath: '/kimi/v1' }, { shape: 'anthropic_messages', basePath: '/kimi' }],
    listModels: async () => [{ id: 'kimi-for-coding' }, { id: 'kimi-for-coding-highspeed' }],
    registerRoutes: (app, gateway) => registerKimiRoutes(app, gateway),
  };
  return [claude,
    chatgpt,
    pending('gemini', 'Gemini', 'gemini', 'cli_login'),
    kimi,
    pending('qwen', 'Qwen', 'qwen', 'vendor_key')];
}
