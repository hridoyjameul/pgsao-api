import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/config.js';
import { FakeClaudeProvider } from './fake-claude-provider.js';

export const TEST_API_KEY = 'test_gateway_key_1234567890abcdef';

export async function startTestApp(envOverrides: Record<string, string> = {}) {
  const config = loadConfig({
    GATEWAY_API_KEY: TEST_API_KEY,
    LOG_LEVEL: 'silent',
    ...envOverrides,
  } as unknown as NodeJS.ProcessEnv);

  const claudeProvider = new FakeClaudeProvider();
  const app = buildApp({ config, claudeProvider, dbPath: ':memory:' });
  await app.gateway.credentialMonitor.checkNow();
  await app.listen({ port: 0, host: '127.0.0.1' });

  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    app,
    baseUrl,
    claudeProvider,
    close: () => app.close(),
  };
}
