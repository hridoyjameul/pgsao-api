/**
 * Spike 04 — credential-expiry detection proof.
 *
 * Part A is safe and automated: it points the SDK subprocess at an empty
 * CLAUDE_CONFIG_DIR (via Options.env) so it finds no credentials there,
 * without touching your real ~/.claude login. Part B still does NOT
 * auto-invalidate your real credentials — that would be a destructive,
 * irreversible action against your actual login — so it prints a manual
 * repro instead.
 *
 * Run: npm run spike:04
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { section } from './lib.js';

const ISOLATED_OPTIONS: Options = { tools: [], settingSources: [] };

async function checkCredentials(options: Options = ISOLATED_OPTIONS): Promise<{ ok: boolean; ms: number; detail: string }> {
  const start = Date.now();
  const q = query({ prompt: 'Say OK.', options });
  try {
    const info = await q.accountInfo();
    // Drain so the subprocess exits cleanly.
    for await (const _ of q) {
      /* drain */
    }
    return { ok: true, ms: Date.now() - start, detail: JSON.stringify(info) };
  } catch (err) {
    return { ok: false, ms: Date.now() - start, detail: (err as Error).message };
  }
}

async function checkWithEmptyConfigDir(): Promise<{ ok: boolean; ms: number; detail: string }> {
  const emptyDir = mkdtempSync(join(tmpdir(), 'pigsao-empty-creds-'));
  try {
    return await checkCredentials({
      ...ISOLATED_OPTIONS,
      env: { ...process.env, CLAUDE_CONFIG_DIR: emptyDir, ANTHROPIC_API_KEY: undefined },
    });
  } finally {
    rmSync(emptyDir, { recursive: true, force: true });
  }
}

async function main() {
  section('Part A — real credentials (baseline)');
  const result = await checkCredentials();
  console.log(result);

  section('Part A2 — safe automated invalid-credential probe (empty CLAUDE_CONFIG_DIR, real login untouched)');
  const invalidResult = await checkWithEmptyConfigDir();
  console.log(invalidResult);
  console.log(
    invalidResult.ok
      ? 'UNEXPECTED: empty config dir still succeeded — investigate before trusting credential-monitor.ts on this signal alone.'
      : `Confirmed distinguishable failure in ${invalidResult.ms}ms — record this exact detail string in FINDINGS.md as the credential_error signature.`
  );

  if (result.ok) {
    console.log(
      '\nCredentials currently VALID. To complete this spike:\n' +
        '  1. In another terminal, log out (e.g. `claude /logout`, or rename/remove the credentials file).\n' +
        '  2. Re-run `npm run spike:04` and confirm it fails FAST (a few seconds) with a\n' +
        '     distinguishable error rather than hanging until REQUEST_TIMEOUT_MS.\n' +
        '  3. Log back in and record the exact error shape/latency in spikes/FINDINGS.md —\n' +
        '     this is what auth/credential-monitor.ts\'s checkCredentials() must detect.\n' +
        '  4. Re-run once more after logging back in to confirm recovery is also detected.'
    );
  } else {
    console.log('\nCredentials appear INVALID/unreachable right now — record this exact error shape\n' + 'and latency in spikes/FINDINGS.md as the credential_error detection signature.');
  }
}

main().catch((err) => {
  console.error('Spike 04 failed:', err);
  process.exitCode = 1;
});
