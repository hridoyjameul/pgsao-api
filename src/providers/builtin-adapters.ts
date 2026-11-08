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
import type { ClaudeAccountStore } from '../claude/accounts.js';
import type { ClaudeLoginManager } from '../claude/login.js';
import type { ProviderAccounts } from '../accounts/types.js';
import { CLAUDE_EFFORTS } from './types.js';

/** Reasoning effort values the ChatGPT Responses API accepts. */
export const CHATGPT_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export const KIMI_EFFORTS = ['off', 'on'] as const;

type Detector = typeof detectExecutable;

export function createBuiltinAdapters(credentialMonitor: CredentialMonitor, config: Config, chatGptConnection: ChatGptConnection, kimiConnection: KimiConnection, claudeAccounts: ClaudeAccountStore, claudeLogins: ClaudeLoginManager, detector: Detector = detectExecutable): ProviderAdapter[] {
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

  const claudeAccountList: ProviderAccounts = {
    list: async () => {
      const { selectedId, accounts } = await claudeAccounts.entries();
      return accounts.map((account) => {
        const status = credentialMonitor.statusFor(account.id);
        const email = status.ok ? status.email : undefined;
        return {
          id: account.id,
          label: account.kind === 'machine_login' && email ? `${email} (this computer's login)` : account.label,
          ...(status.ok ? { detail: [account.kind !== 'machine_login' ? email : undefined, status.subscriptionType].filter(Boolean).join(' - ') || undefined } : { detail: status.message }),
          active: account.id === selectedId,
          connected: status.ok,
        };
      });
    },
    select: async (accountId) => { await claudeAccounts.select(accountId); credentialMonitor.setActive(accountId); },
    remove: async (accountId) => {
      const removed = await claudeAccounts.remove(accountId);
      // A folder made by the dashboard sign-in holds that login; delete it with the account.
      if (removed?.type === 'config_dir') await claudeLogins.removeFolder(removed.configDir);
      credentialMonitor.forget(accountId);
      credentialMonitor.setActive((await claudeAccounts.entries()).selectedId);
    },
  };

  const claude: ProviderAdapter = {
    id: 'claude', displayName: 'Claude', connectionMethod: 'existing_session',
    detectClient: async () => detected('claude'),
    getConnection: async () => {
      const status = credentialMonitor.status;
      if (!status.ok) return { state: 'disconnected', detail: status.message };
      return { state: 'connected', detail: [status.email, status.subscriptionType].filter(Boolean).join(' - ') || undefined };
    },
    accounts: claudeAccountList,
    tuning: { efforts: CLAUDE_EFFORTS, effortLabel: 'Effort / thinking' },
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
    accounts: chatGptConnection,
    tuning: { efforts: CHATGPT_EFFORTS, effortLabel: 'Reasoning effort' },
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
    accounts: kimiConnection,
    tuning: { efforts: KIMI_EFFORTS, effortLabel: 'Thinking' },
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
