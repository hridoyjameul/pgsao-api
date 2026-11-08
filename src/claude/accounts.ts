import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { SecureJsonFile } from '../accounts/secure-file.js';
import { UnknownAccountError } from '../accounts/types.js';
import type { ClaudeAuth } from '../providers/types.js';

/** The account Claude Code is already logged into on this machine (~/.claude or CLAUDE_CONFIG_DIR). Always present. */
export const DEFAULT_CLAUDE_ACCOUNT = 'default';

const TOKEN_PATTERN = /^[\x21-\x7e]{20,2048}$/;

export type StoredClaudeAccount =
  | { id: string; label: string; type: 'token'; token: string }
  | { id: string; label: string; type: 'config_dir'; configDir: string };

interface ClaudeAccountState { selectedId?: string; accounts: StoredClaudeAccount[] }

export type NewClaudeAccount = { label?: string; token: string } | { label?: string; configDir: string };

function parseState(value: unknown): ClaudeAccountState {
  const raw = value as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.accounts) || (raw.selectedId !== undefined && typeof raw.selectedId !== 'string')) {
    throw new Error('Invalid Claude account file');
  }
  for (const item of raw.accounts) {
    const a = item as Record<string, unknown>;
    const ok = a && typeof a.id === 'string' && typeof a.label === 'string'
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
    const selectedId = state.selectedId && state.accounts.some((a) => a.id === state.selectedId) ? state.selectedId : DEFAULT_CLAUDE_ACCOUNT;
    return {
      selectedId,
      accounts: [
        { id: DEFAULT_CLAUDE_ACCOUNT, label: 'This computer\'s Claude login', kind: 'machine_login' },
        ...state.accounts.map((a) => ({ id: a.id, label: a.label, kind: a.type })),
      ],
    };
  }

  /** Auth for the active account, or for `accountId` when an API key is pinned to one. Undefined account id = machine login. */
  async resolve(accountId?: string): Promise<ClaudeAuth> {
    const state = await this.load();
    const id = accountId ?? state.selectedId ?? DEFAULT_CLAUDE_ACCOUNT;
    if (id === DEFAULT_CLAUDE_ACCOUNT) return { accountId: DEFAULT_CLAUDE_ACCOUNT };
    const account = state.accounts.find((a) => a.id === id);
    if (!account) {
      if (accountId) throw new UnknownAccountError();
      return { accountId: DEFAULT_CLAUDE_ACCOUNT };
    }
    return { accountId: account.id, env: envFor(account) };
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
      if (accountId !== DEFAULT_CLAUDE_ACCOUNT && !state.accounts.some((a) => a.id === accountId)) throw new UnknownAccountError();
      state.selectedId = accountId === DEFAULT_CLAUDE_ACCOUNT ? undefined : accountId;
    });
  }

  async remove(accountId: string): Promise<void> {
    if (accountId === DEFAULT_CLAUDE_ACCOUNT) throw new Error('The machine login cannot be removed here; log out with `claude /logout`');
    await this.mutate((state) => {
      if (!state.accounts.some((a) => a.id === accountId)) throw new UnknownAccountError();
      state.accounts = state.accounts.filter((a) => a.id !== accountId);
      if (state.selectedId === accountId) state.selectedId = undefined;
    });
  }
}
