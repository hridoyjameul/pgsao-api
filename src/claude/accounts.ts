import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { SecureJsonFile } from '../accounts/secure-file.js';
import { UnknownAccountError } from '../accounts/types.js';
import type { ClaudeAuth } from '../providers/types.js';

/** The account Claude Code is already logged into on this machine (~/.claude or CLAUDE_CONFIG_DIR). Listed unless removed. */
export const DEFAULT_CLAUDE_ACCOUNT = 'default';

const TOKEN_PATTERN = /^[\x21-\x7e]{20,2048}$/;

/** `email` is the login's address when last verified, so a duplicate can be spotted even after that login stops working. */
export type StoredClaudeAccount =
  | { id: string; label: string; email?: string; type: 'token'; token: string }
  | { id: string; label: string; email?: string; type: 'config_dir'; configDir: string };

interface ClaudeAccountState {
  selectedId?: string;
  accounts: StoredClaudeAccount[];
  /** The machine login was removed from the list (the login on this computer itself is left alone). */
  machineLoginRemoved?: boolean;
  machineLoginEmail?: string;
  /** Move a request to another account when the chosen one hits its usage limit. */
  fallback?: boolean;
}

export type NewClaudeAccount = { label?: string; token: string } | { label?: string; configDir: string };

function parseState(value: unknown): ClaudeAccountState {
  const raw = value as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.accounts) || (raw.selectedId !== undefined && typeof raw.selectedId !== 'string')
    || (raw.machineLoginRemoved !== undefined && typeof raw.machineLoginRemoved !== 'boolean')
    || (raw.machineLoginEmail !== undefined && typeof raw.machineLoginEmail !== 'string')
    || (raw.fallback !== undefined && typeof raw.fallback !== 'boolean')) {
    throw new Error('Invalid Claude account file');
  }
  for (const item of raw.accounts) {
    const a = item as Record<string, unknown>;
    const ok = a && typeof a.id === 'string' && typeof a.label === 'string' && (a.email === undefined || typeof a.email === 'string')
      && ((a.type === 'token' && typeof a.token === 'string') || (a.type === 'config_dir' && typeof a.configDir === 'string'));
    if (!ok) throw new Error('Invalid Claude account file');
  }
  return raw as unknown as ClaudeAccountState;
}

/** Environment for one Claude Code subprocess, so it authenticates as exactly this account. */
function envFor(account: StoredClaudeAccount): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  // An inherited API key would otherwise outrank the chosen subscription login.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  if (account.type === 'token') env.CLAUDE_CODE_OAUTH_TOKEN = account.token;
  else env.CLAUDE_CONFIG_DIR = account.configDir;
  return env;
}

/** The address Claude Code saved for a login folder (`.claude.json`); still readable after the login expires. */
async function savedLoginEmail(configDir?: string): Promise<string | undefined> {
  const file = configDir ? join(configDir, '.claude.json')
    : process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : join(homedir(), '.claude.json');
  try {
    const email = (JSON.parse(await readFile(file, 'utf8')) as { oauthAccount?: { emailAddress?: unknown } }).oauthAccount?.emailAddress;
    return typeof email === 'string' && email ? email : undefined;
  } catch { return undefined; }
}

function machineLoginListed(state: ClaudeAccountState): boolean {
  return !state.machineLoginRemoved || state.accounts.length === 0;
}

/** The chosen account if it still exists, else the machine login, else the first added account. */
function activeId(state: ClaudeAccountState): string {
  if (state.selectedId && state.accounts.some((a) => a.id === state.selectedId)) return state.selectedId;
  return machineLoginListed(state) ? DEFAULT_CLAUDE_ACCOUNT : state.accounts[0]!.id;
}

export interface ClaudeAccountEntry { id: string; label: string; kind: 'machine_login' | 'token' | 'config_dir' }

/**
 * Extra Claude subscription accounts beside the machine's own login: a
 * long-lived `claude setup-token` OAuth token, or a separate Claude Code config
 * directory logged in with `CLAUDE_CONFIG_DIR=<dir> claude`. Secrets live in a
 * private file and are never returned by any API.
 */
export class ClaudeAccountStore {
  private readonly file?: SecureJsonFile<ClaudeAccountState>;
  private memory: ClaudeAccountState = { accounts: [] };

  constructor(path?: string) {
    if (path) this.file = new SecureJsonFile(path, parseState);
  }

  private async load(): Promise<ClaudeAccountState> {
    if (!this.file) return this.memory;
    return (await this.file.read().catch(() => undefined)) ?? { accounts: [] };
  }

  private async mutate<R>(fn: (state: ClaudeAccountState) => R): Promise<R> {
    if (!this.file) return fn(this.memory);
    return this.file.update((current) => {
      const next = current ?? { accounts: [] };
      return { next, result: fn(next) };
    });
  }

  async entries(): Promise<{ selectedId: string; accounts: ClaudeAccountEntry[] }> {
    const state = await this.load();
    return {
      selectedId: activeId(state),
      accounts: [
        ...(machineLoginListed(state) ? [{ id: DEFAULT_CLAUDE_ACCOUNT, label: 'This computer\'s Claude login', kind: 'machine_login' as const }] : []),
        ...state.accounts.map((a) => ({ id: a.id, label: a.label, kind: a.type })),
      ],
    };
  }

  /** Auth for the active account, or for `accountId` when an API key is pinned to one. */
  async resolve(accountId?: string): Promise<ClaudeAuth> {
    const state = await this.load();
    const id = accountId ?? activeId(state);
    if (id === DEFAULT_CLAUDE_ACCOUNT) return { accountId: DEFAULT_CLAUDE_ACCOUNT };
    const account = state.accounts.find((a) => a.id === id);
    if (!account) throw new UnknownAccountError();
    return { accountId: account.id, env: envFor(account) };
  }

  /** Last known sign-in address of an account, even one whose login has stopped working. */
  async emailOf(accountId: string): Promise<string | undefined> {
    const state = await this.load();
    if (accountId === DEFAULT_CLAUDE_ACCOUNT) return state.machineLoginEmail ?? await savedLoginEmail();
    const account = state.accounts.find((a) => a.id === accountId);
    if (!account) return undefined;
    return account.email ?? (account.type === 'config_dir' ? await savedLoginEmail(account.configDir) : undefined);
  }

  /** Saves addresses seen in successful checks; writes only when one changed. */
  async rememberEmails(emails: ReadonlyMap<string, string>): Promise<void> {
    const state = await this.load();
    const known = (s: ClaudeAccountState, id: string) => id === DEFAULT_CLAUDE_ACCOUNT ? s.machineLoginEmail : s.accounts.find((a) => a.id === id)?.email;
    const exists = (s: ClaudeAccountState, id: string) => id === DEFAULT_CLAUDE_ACCOUNT || s.accounts.some((a) => a.id === id);
    if (![...emails].some(([id, email]) => exists(state, id) && known(state, id) !== email)) return;
    await this.mutate((next) => {
      for (const [id, email] of emails) {
        if (id === DEFAULT_CLAUDE_ACCOUNT) next.machineLoginEmail = email;
        else { const a = next.accounts.find((x) => x.id === id); if (a) a.email = email; }
      }
    });
  }

  async fallbackEnabled(): Promise<boolean> {
    return (await this.load()).fallback === true;
  }

  async setFallback(enabled: boolean): Promise<void> {
    await this.mutate((state) => { state.fallback = enabled; });
  }

  /** Validates input shape; returns the account to save (not yet persisted) and the auth to verify it with. */
  async prepare(input: NewClaudeAccount): Promise<{ account: StoredClaudeAccount; auth: ClaudeAuth }> {
    const id = randomUUID();
    const label = input.label?.trim() ?? '';
    let account: StoredClaudeAccount;
    if ('token' in input) {
      if (!TOKEN_PATTERN.test(input.token)) throw new Error('Enter the token printed by `claude setup-token`');
      account = { id, label: label || 'Claude account (token)', type: 'token', token: input.token };
    } else {
      if (!isAbsolute(input.configDir)) throw new Error('Enter an absolute folder path');
      const dir = resolve(input.configDir);
      const info = await stat(dir).catch(() => undefined);
      if (!info?.isDirectory()) throw new Error('That folder does not exist');
      account = { id, label: label || 'Claude account (folder)', type: 'config_dir', configDir: dir };
    }
    return { account, auth: { accountId: id, env: envFor(account) } };
  }

  async add(account: StoredClaudeAccount, makeActive = true): Promise<void> {
    await this.mutate((state) => {
      state.accounts.push(account);
      if (makeActive) state.selectedId = account.id;
    });
  }

  async select(accountId: string): Promise<void> {
    await this.mutate((state) => {
      const known = accountId === DEFAULT_CLAUDE_ACCOUNT ? machineLoginListed(state) : state.accounts.some((a) => a.id === accountId);
      if (!known) throw new UnknownAccountError();
      state.selectedId = accountId === DEFAULT_CLAUDE_ACCOUNT ? undefined : accountId;
    });
  }

  /** Puts the machine login back in the list after it was removed. */
  async restoreMachineLogin(makeActive = true): Promise<void> {
    await this.mutate((state) => {
      delete state.machineLoginRemoved;
      if (makeActive) delete state.selectedId;
    });
  }

  /**
   * Removes an account and returns it (undefined for the machine login) so its
   * login folder can be cleaned up. The machine login only leaves the list;
   * the login on this computer is untouched. The last account cannot be removed.
   */
  async remove(accountId: string): Promise<StoredClaudeAccount | undefined> {
    return this.mutate((state) => {
      if (accountId === DEFAULT_CLAUDE_ACCOUNT) {
        if (!state.accounts.length) throw new Error('Add another Claude account before removing this one');
        if (state.machineLoginRemoved) throw new UnknownAccountError();
        const wasActive = activeId(state) === DEFAULT_CLAUDE_ACCOUNT;
        state.machineLoginRemoved = true;
        if (wasActive) state.selectedId = state.accounts[0]!.id;
        return undefined;
      }
      const account = state.accounts.find((a) => a.id === accountId);
      if (!account) throw new UnknownAccountError();
      if (state.machineLoginRemoved && state.accounts.length === 1) throw new Error('Add another Claude account before removing this one');
      state.accounts = state.accounts.filter((a) => a.id !== accountId);
      if (state.selectedId === accountId) delete state.selectedId;
      return account;
    });
  }

  /**
   * Swaps an existing account's login for a new login of the same person. A
   * stored account keeps its id, name and pinned keys; the machine login leaves
   * the list and the new account takes its place. Returns the account id now
   * in use and the replaced stored login (for folder cleanup).
   */
  async replace(oldId: string, account: StoredClaudeAccount): Promise<{ accountId: string; replaced?: StoredClaudeAccount }> {
    return this.mutate((state) => {
      if (oldId === DEFAULT_CLAUDE_ACCOUNT) {
        if (!machineLoginListed(state)) throw new UnknownAccountError();
        const wasActive = activeId(state) === DEFAULT_CLAUDE_ACCOUNT;
        state.accounts.push(account);
        state.machineLoginRemoved = true;
        if (wasActive) state.selectedId = account.id;
        return { accountId: account.id };
      }
      const index = state.accounts.findIndex((a) => a.id === oldId);
      if (index < 0) throw new UnknownAccountError();
      const replaced = state.accounts[index]!;
      state.accounts[index] = { ...account, id: oldId, label: replaced.label };
      return { accountId: oldId, replaced };
    });
  }
}
