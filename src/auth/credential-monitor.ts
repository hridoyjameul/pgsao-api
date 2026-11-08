import type { ClaudeProvider, CredentialStatus } from '../providers/types.js';
import type { ClaudeAccountStore } from '../claude/accounts.js';
import { ApiError } from '../errors/api-error.js';

const NOT_CHECKED: CredentialStatus = { ok: false, message: 'not yet checked' };

/**
 * Periodic + on-demand Agent SDK auth validity checks (PRD §6.7), for every
 * configured Claude account. Fails new requests fast with credential_error
 * (503) rather than letting a doomed Claude call hang until
 * REQUEST_TIMEOUT_MS. See spikes/FINDINGS.md's empirical invalid-credential
 * probe (~1.1s, "Not logged in").
 */
export class CredentialMonitor {
  private readonly statuses = new Map<string, CredentialStatus>();
  private activeId = 'default';
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly provider: ClaudeProvider,
    private readonly intervalMs: number,
    private readonly accounts?: ClaudeAccountStore,
  ) {}

  /** Status of the active Claude account. */
  get status(): CredentialStatus {
    return this.statuses.get(this.activeId) ?? NOT_CHECKED;
  }

  statusFor(accountId: string): CredentialStatus {
    return this.statuses.get(accountId) ?? NOT_CHECKED;
  }

  /** Re-checks every account; returns the active account's status. */
  async checkNow(): Promise<CredentialStatus> {
    if (!this.accounts) {
      this.statuses.set(this.activeId, await this.provider.checkCredentials());
      return this.status;
    }
    const { selectedId, accounts } = await this.accounts.entries();
    this.activeId = selectedId;
    const results = await Promise.all(accounts.map(async ({ id }) => {
      const auth = await this.accounts!.resolve(id).catch(() => undefined);
      return [id, auth ? await this.provider.checkCredentials(auth.env ? auth : undefined) : NOT_CHECKED] as const;
    }));
    this.statuses.clear();
    for (const [id, status] of results) this.statuses.set(id, status);
    return this.status;
  }

  setActive(accountId: string): void {
    this.activeId = accountId;
  }

  forget(accountId: string): void {
    this.statuses.delete(accountId);
  }

  /** Records a freshly verified account so it is usable without waiting for the next periodic check. */
  record(accountId: string, status: CredentialStatus): void {
    this.statuses.set(accountId, status);
  }

  assertValid(accountId?: string): void {
    const status = accountId ? this.statusFor(accountId) : this.status;
    if (!status.ok) {
      throw new ApiError('credential_error', `Claude credentials are not valid: ${status.message}`);
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
