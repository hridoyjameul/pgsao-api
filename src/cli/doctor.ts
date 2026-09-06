import net from 'node:net';
import { loadDotenv } from '../utils/load-dotenv.js';
import { loadConfig, type Config } from '../config/config.js';
import { buildApp } from '../app.js';
import { AgentSdkClaudeProvider } from '../providers/claude.js';

interface CheckResult {
  label: string;
  ok: boolean;
  detail?: string;
}

function print(result: CheckResult): void {
  console.log(`${result.ok ? '✓' : '✗'} ${result.label}${result.detail ? ` (${result.detail})` : ''}`);
}

function checkNodeVersion(): CheckResult {
  const [major, minor] = process.versions.node.split('.').map(Number) as [number, number];
  const ok = major! > 22 || (major === 22 && minor! >= 5);
  return { label: 'Node.js', ok, detail: ok ? process.version : `${process.version} — need >=22.5.0 (node:sqlite)` };
}

async function checkAgentSdkInstalled(): Promise<CheckResult> {
  try {
    await import('@anthropic-ai/claude-agent-sdk');
    return { label: 'Agent SDK installed', ok: true };
  } catch (err) {
    return { label: 'Agent SDK installed', ok: false, detail: (err as Error).message };
  }
}

function checkConfig(): { result: CheckResult; config?: Config } {
  try {
    const config = loadConfig();
    return { result: { label: 'Gateway configuration valid', ok: true }, config };
  } catch (err) {
    return { result: { label: 'Gateway configuration valid', ok: false, detail: (err as Error).message } };
  }
}

async function checkPortAvailable(host: string, port: number): Promise<CheckResult> {
  const isOwnGateway = await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(1000) })
    .then((res) => res.json())
    .then((body: any) => body?.service === 'pgsao-api')
    .catch(() => false);
  if (isOwnGateway) return { label: `Port ${port} available`, ok: true, detail: 'already running this gateway' };

  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve({ label: `Port ${port} available`, ok: false, detail: 'in use by something else' }));
    server.once('listening', () => server.close(() => resolve({ label: `Port ${port} available`, ok: true })));
    server.listen(port, host);
  });
}

async function checkAuthentication(): Promise<CheckResult> {
  const status = await new AgentSdkClaudeProvider().checkCredentials();
  return status.ok
    ? { label: 'Authentication available', ok: true, detail: `checked just now, valid${status.email ? ` — ${status.email}` : ''}` }
    : { label: 'Authentication available', ok: false, detail: status.message };
}

async function checkRoutesResponding(config: Config): Promise<CheckResult[]> {
  // Quiet — this is a CLI check, not a running server; request logs would just be noise here.
  const app = await buildApp({ config: { ...config, LOG_LEVEL: 'silent' }, claudeProvider: new AgentSdkClaudeProvider() });
  try {
    const headers = { authorization: `Bearer ${config.GATEWAY_API_KEY}`, 'content-type': 'application/json' };
    const [anthropicRes, openaiRes] = await Promise.all([
      app.inject({ method: 'POST', url: '/v1/messages', headers, payload: { model: 'claude-via-gateway', max_tokens: 8, messages: [{ role: 'user', content: 'Say OK.' }] } }),
      app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: { model: 'claude-via-gateway', max_tokens: 8, messages: [{ role: 'user', content: 'Say OK.' }] } }),
    ]);
    return [
      { label: '/v1/messages responding', ok: anthropicRes.statusCode === 200, detail: anthropicRes.statusCode !== 200 ? `HTTP ${anthropicRes.statusCode}` : undefined },
      { label: '/v1/chat/completions responding', ok: openaiRes.statusCode === 200, detail: openaiRes.statusCode !== 200 ? `HTTP ${openaiRes.statusCode}` : undefined },
    ];
  } finally {
    await app.close();
  }
}

/** `pgsao-api doctor` (PRD §18) — a real end-to-end check, not just config validation: makes two small live Claude calls (via Fastify `.inject()`, no port bound) to confirm both routes actually work. */
export async function doctor(): Promise<void> {
  loadDotenv();

  const results: CheckResult[] = [checkNodeVersion()];
  print(results[0]!);

  const sdkResult = await checkAgentSdkInstalled();
  results.push(sdkResult);
  print(sdkResult);

  const authResult = await checkAuthentication();
  results.push(authResult);
  print(authResult);

  const { result: configResult, config } = checkConfig();
  results.push(configResult);
  print(configResult);

  if (!config) {
    console.log('\nNot ready — fix the configuration above first.');
    process.exitCode = 1;
    return;
  }

  const portResult = await checkPortAvailable(config.HOST, config.PORT);
  results.push(portResult);
  print(portResult);

  const concurrencyResult: CheckResult = { label: 'Concurrency limit configured', ok: true, detail: `MAX_CONCURRENT_REQUESTS=${config.MAX_CONCURRENT_REQUESTS}` };
  results.push(concurrencyResult);
  print(concurrencyResult);

  if (!authResult.ok) {
    console.log('\nSkipping live route checks — fix authentication first.');
    process.exitCode = 1;
    return;
  }

  const routeResults = await checkRoutesResponding(config);
  for (const r of routeResults) print(r);
  results.push(...routeResults);

  console.log();
  if (results.every((r) => r.ok)) {
    console.log('Ready.');
  } else {
    console.log('Not ready — see the items above.');
    process.exitCode = 1;
  }
}
