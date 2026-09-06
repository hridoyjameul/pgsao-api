import type { ClaudeProvider, CredentialStatus } from '../providers/types.js';
import { ApiError } from '../errors/api-error.js';

/**
 * Periodic + on-demand Agent SDK auth validity checks (PRD §6.7). Fails new
 * requests fast with credential_error (503) rather than letting a doomed
 * Claude call hang until REQUEST_TIMEOUT_MS. See spikes/FINDINGS.md's
 * empirical invalid-credential probe (~1.1s, "Not logged in").
 */
export class CredentialMonitor {
  private latest: CredentialStatus = { ok: false, message: 'not yet checked' };
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly provider: ClaudeProvider,
    private readonly intervalMs: number
  ) {}

  get status(): CredentialStatus {
    return this.latest;
  }

  async checkNow(): Promise<CredentialStatus> {
    this.latest = await this.provider.checkCredentials();
    return this.latest;
  }

  assertValid(): void {
    if (!this.latest.ok) {
      throw new ApiError('credential_error', `Claude credentials are not valid: ${this.latest.message}`);
    }
  }

  /** Starts periodic re-checks only. Callers must `await checkNow()` once before serving traffic — see server.ts / tests/support/test-server.ts — otherwise every request would fail fast on the default "not yet checked" status. */
  start(): void {
    this.timer = setInterval(() => void this.checkNow(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
