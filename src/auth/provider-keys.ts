import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ProviderId } from '../providers/registry.js';

export const PROVIDER_IDS: readonly ProviderId[] = ['claude', 'chatgpt', 'gemini', 'kimi', 'qwen'];

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

/**
 * One gateway API key for one provider, with the settings requests made with
 * it use. Unset settings leave the caller's own request (or the active
 * account) in charge.
 */
export interface ApiKeyProfile {
  id: string;
  provider: ProviderId;
  name: string;
  key: string;
  /** Account this key always uses; unset => whichever account is active. */
  accountId?: string;
  /** Model that replaces the request's `model`; unset => the caller chooses. */
  model?: string;
  /** Reasoning effort / thinking level; unset => provider default or the caller's own value. */
  effort?: string;
  createdAt: number;
}

export type ProfileSettings = Partial<Pick<ApiKeyProfile, 'name' | 'accountId' | 'model' | 'effort'>>;
/** `null` clears a setting back to "caller / active account decides". */
export type ProfilePatch = { name?: string; accountId?: string | null; model?: string | null; effort?: string | null };

interface StoredFile { version: 2; profiles: ApiKeyProfile[] }

function isProfile(value: unknown): value is ApiKeyProfile {
  const p = value as Record<string, unknown>;
  return !!p && typeof p.id === 'string' && typeof p.provider === 'string' && isProviderId(p.provider)
    && typeof p.name === 'string' && typeof p.key === 'string' && typeof p.createdAt === 'number'
    && ['accountId', 'model', 'effort'].every((k) => p[k] === undefined || typeof p[k] === 'string');
}

function sameKey(expected: string, presented: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Any number of API keys per provider. Persisted to a private JSON file, or kept in memory when no path is given. */
export class ProviderKeyStore {
  private profiles: ApiKeyProfile[] = [];

  constructor(private readonly path?: string) {
    if (!path) return;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      if (parsed.version === 2 && Array.isArray(parsed.profiles)) {
        this.profiles = parsed.profiles.filter(isProfile);
      } else {
        // Version 1: { claude: "sk-pgsao-claude-..." } — one key per provider; keep each one working.
        for (const id of PROVIDER_IDS) {
          if (typeof parsed[id] === 'string' && parsed[id]) this.profiles.push(this.newProfile(id, { name: 'Default' }, parsed[id] as string));
        }
        if (this.profiles.length) this.persist();
      }
    } catch { /* first run or unreadable file: keys are generated on demand */ }
  }

  list(provider: ProviderId): ApiKeyProfile[] {
    this.ensureOne(provider);
    return this.profiles.filter((p) => p.provider === provider).map((p) => ({ ...p }));
  }

  byId(provider: ProviderId, id: string): ApiKeyProfile | undefined {
    const found = this.profiles.find((p) => p.provider === provider && p.id === id);
    return found && { ...found };
  }

  create(provider: ProviderId, settings: ProfileSettings = {}): ApiKeyProfile {
    const count = this.profiles.filter((p) => p.provider === provider).length;
    const profile = this.newProfile(provider, { ...settings, name: settings.name?.trim() || (count ? `Key ${count + 1}` : 'Default') });
    this.profiles.push(profile);
    this.persist();
    return { ...profile };
  }

  update(provider: ProviderId, id: string, patch: ProfilePatch): ApiKeyProfile | undefined {
    const profile = this.profiles.find((p) => p.provider === provider && p.id === id);
    if (!profile) return undefined;
    if (patch.name !== undefined) profile.name = patch.name.trim() || profile.name;
    for (const field of ['accountId', 'model', 'effort'] as const) {
      const value = patch[field];
      if (value === null || value === '') delete profile[field];
      else if (value !== undefined) profile[field] = value;
    }
    this.persist();
    return { ...profile };
  }

  /** False when it is the provider's last key — every provider keeps at least one. */
  delete(provider: ProviderId, id: string): boolean {
    const own = this.profiles.filter((p) => p.provider === provider);
    if (own.length <= 1 || !own.some((p) => p.id === id)) return false;
    this.profiles = this.profiles.filter((p) => p.id !== id);
    this.persist();
    return true;
  }

  rotateProfile(provider: ProviderId, id: string): ApiKeyProfile | undefined {
    const profile = this.profiles.find((p) => p.provider === provider && p.id === id);
    if (!profile) return undefined;
    profile.key = this.generate(provider);
    this.persist();
    return { ...profile };
  }

  /** Clears an account pin from every key using it (the account was removed). */
  unpinAccount(provider: ProviderId, accountId: string): void {
    let changed = false;
    for (const p of this.profiles) if (p.provider === provider && p.accountId === accountId) { delete p.accountId; changed = true; }
    if (changed) this.persist();
  }

  /** The provider's first key (the single-key API kept for older dashboards and scripts). */
  get(provider: ProviderId): string {
    return this.list(provider)[0]!.key;
  }

  rotate(provider: ProviderId): string {
    return this.rotateProfile(provider, this.list(provider)[0]!.id)!.key;
  }

  /** The profile whose key was presented, if it belongs to this provider. */
  find(provider: ProviderId, presented: string): ApiKeyProfile | undefined {
    this.ensureOne(provider);
    let match: ApiKeyProfile | undefined;
    // Compare against every key so timing does not reveal which one matched.
    for (const p of this.profiles) if (p.provider === provider && sameKey(p.key, presented)) match = p;
    return match && { ...match };
  }

  matches(provider: ProviderId, presented: string): boolean {
    return this.find(provider, presented) !== undefined;
  }

  private ensureOne(provider: ProviderId): void {
    if (!this.profiles.some((p) => p.provider === provider)) {
      this.profiles.push(this.newProfile(provider, { name: 'Default' }));
      this.persist();
    }
  }

  private newProfile(provider: ProviderId, settings: ProfileSettings, key = this.generate(provider)): ApiKeyProfile {
    const profile: ApiKeyProfile = { id: randomUUID(), provider, name: settings.name ?? 'Default', key, createdAt: Date.now() };
    if (settings.accountId) profile.accountId = settings.accountId;
    if (settings.model) profile.model = settings.model;
    if (settings.effort) profile.effort = settings.effort;
    return profile;
  }

  private generate(provider: ProviderId): string {
    return `sk-pgsao-${provider}-${randomBytes(24).toString('hex')}`;
  }

  private persist(): void {
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const temp = `${this.path}.tmp`;
      const file: StoredFile = { version: 2, profiles: this.profiles };
      writeFileSync(temp, JSON.stringify(file), { mode: 0o600 });
      renameSync(temp, this.path);
      try { chmodSync(this.path, 0o600); } catch { /* best effort on Windows */ }
    } catch { /* keep working in memory if the data dir is read-only */ }
  }
}
