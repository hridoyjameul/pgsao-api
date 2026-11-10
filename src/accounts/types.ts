/** One signed-in account (or vendor key) a provider can serve requests with. Never carries a secret. */
export interface AccountSummary {
  id: string;
  label: string;
  /** e.g. plan type or "Key ending 1a2b". */
  detail?: string;
  /** The account requests use unless an API key is pinned to another one. */
  active: boolean;
  /** False when the stored credential needs reconnecting. */
  connected: boolean;
}

/** Shared account list/switch/remove contract; adding an account stays provider specific (OAuth, vendor key, token). */
export interface ProviderAccounts {
  list(): Promise<AccountSummary[]>;
  select(accountId: string): Promise<void>;
  remove(accountId: string): Promise<void>;
  /** Present when the provider can move a request to another account once the chosen one hits its usage limit. */
  fallback?: { enabled(): Promise<boolean>; set(enabled: boolean): Promise<void> };
}

export class UnknownAccountError extends Error {
  constructor() { super('Unknown account'); }
}
