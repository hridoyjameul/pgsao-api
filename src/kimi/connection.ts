import { randomUUID } from 'node:crypto';
import type { ProviderStatus } from '../providers/registry.js';
import { SecureJsonFile } from '../accounts/secure-file.js';
import { UnknownAccountError, type AccountSummary, type ProviderAccounts } from '../accounts/types.js';

const KEY_PATTERN = /^[\x21-\x7e]{8,512}$/;
const LABEL_PATTERN = /^[^\x00-\x1f\x7f]{1,64}$/;

export function isValidKimiKey(value: unknown): value is string {
  return typeof value === 'string' && KEY_PATTERN.test(value);
}

export function isValidAccountLabel(value: unknown): value is string {
  return typeof value === 'string' && LABEL_PATTERN.test(value.trim());
}

export interface KimiAccount { id: string; label: string; apiKey: string }
export interface KimiState { selectedId?: string; accounts: KimiAccount[] }

function parseState(value: unknown): KimiState {
  if (!value || typeof value !== 'object') throw new Error('Invalid Kimi credential file');
  const raw = value as Record<string, unknown>;
  // Single-key file written before multiple accounts existed.
  if (raw.accounts === undefined && isValidKimiKey(raw.apiKey)) {
    return { selectedId: 'default', accounts: [{ id: 'default', label: 'Kimi account', apiKey: raw.apiKey }] };
  }
  if (!Array.isArray(raw.accounts) || (raw.selectedId !== undefined && typeof raw.selectedId !== 'string')) throw new Error('Invalid Kimi credential file');
  for (const item of raw.accounts) {
    const a = item as Record<string, unknown>;
    if (!a || typeof a.id !== 'string' || typeof a.label !== 'string' || !isValidKimiKey(a.apiKey)) throw new Error('Invalid Kimi credential file');
  }
  return raw as unknown as KimiState;
}

/** Holds the owner's Kimi Code membership keys in a private file; keys are never returned by any API. */
export class KimiKeyStore {
  private readonly file: SecureJsonFile<KimiState>;

  constructor(path: string) {
    this.file = new SecureJsonFile(path, parseState);
  }

  get path(): string { return this.file.path; }

  async load(): Promise<KimiState> {
    return (await this.file.read()) ?? { accounts: [] };
  }

  update<R>(mutate: (state: KimiState) => R): Promise<R> {
    return this.file.update((current) => {
      const next = current ?? { accounts: [] };
      const result = mutate(next);
      return { next, result };
    });
  }
}

function keyDetail(apiKey: string): string {
  return `Key ending ${apiKey.slice(-4)}`;
}

export class KimiConnection implements ProviderAccounts {
  private limitedUntil = new Map<string, number>();

  constructor(private readonly store: KimiKeyStore) {}

  private active(state: KimiState): KimiAccount | undefined {
    return state.accounts.find((a) => a.id === state.selectedId);
  }

  async status(): Promise<ProviderStatus['connection']> {
    let state: KimiState;
    try { state = await this.store.load(); } catch { return { state: 'disconnected', detail: 'Re-enter your Kimi key' }; }
    const account = this.active(state);
    if (!account) return { state: 'not_configured' };
    const until = this.limitedUntil.get(account.id) ?? 0;
    const limit = until > Date.now() ? ` - limit reached until ${new Date(until).toLocaleTimeString()}` : '';
    const name = state.accounts.length > 1 ? `${account.label} - ` : '';
    return { state: 'connected', detail: `${name}${keyDetail(account.apiKey)}${limit}` };
  }

  async list(): Promise<AccountSummary[]> {
    const state = await this.store.load().catch(() => ({ accounts: [] }) as KimiState);
    return state.accounts.map((a) => ({ id: a.id, label: a.label, detail: keyDetail(a.apiKey), active: a.id === state.selectedId, connected: true }));
  }

  /** The active key, or the key of `accountId` when an API key is pinned to that account. */
  async getKey(accountId?: string): Promise<{ accountId: string; apiKey: string }> {
    const state = await this.store.load().catch(() => undefined);
    const account = state && (accountId ? state.accounts.find((a) => a.id === accountId) : this.active(state));
    if (!account) throw new Error(accountId ? 'Kimi account removed' : 'Kimi key missing');
    return { accountId: account.id, apiKey: account.apiKey };
  }

  /** Adds a key as a new account (or reuses the account that already holds it) and makes it active. */
  saveKey(apiKey: string, label?: string): Promise<string> {
    return this.store.update((state) => {
      let account = state.accounts.find((a) => a.apiKey === apiKey);
      if (!account) {
        account = { id: randomUUID(), label: label?.trim() || `Kimi account ${state.accounts.length + 1}`, apiKey };
        state.accounts.push(account);
      } else if (label?.trim()) account.label = label.trim();
      this.limitedUntil.delete(account.id);
      state.selectedId = account.id;
      return account.id;
    });
  }

  async select(accountId: string): Promise<void> {
    await this.store.update((state) => {
      if (!state.accounts.some((a) => a.id === accountId)) throw new UnknownAccountError();
      state.selectedId = accountId;
    });
  }

  async remove(accountId: string): Promise<void> {
    await this.store.update((state) => {
      if (!state.accounts.some((a) => a.id === accountId)) throw new UnknownAccountError();
      state.accounts = state.accounts.filter((a) => a.id !== accountId);
      if (state.selectedId === accountId) state.selectedId = state.accounts[0]?.id;
    });
    this.limitedUntil.delete(accountId);
  }

  /** Removes the active key (the pre-multi-account "Remove key" behavior). */
  async removeKey(): Promise<void> {
    const state = await this.store.load().catch(() => undefined);
    if (state?.selectedId) await this.remove(state.selectedId);
  }

  noteLimit(accountId: string, retryAfterSeconds?: number): void {
    this.limitedUntil.set(accountId, Date.now() + (retryAfterSeconds ?? 300) * 1000);
  }
}
