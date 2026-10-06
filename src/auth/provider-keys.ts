import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ProviderId } from '../providers/registry.js';

export const PROVIDER_IDS: readonly ProviderId[] = ['claude', 'chatgpt', 'gemini', 'kimi', 'qwen'];

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

/** One independent API key per provider. Persisted to a private JSON file, or kept in memory when no path is given. */
export class ProviderKeyStore {
  private keys: Partial<Record<ProviderId, string>> = {};

  constructor(private readonly path?: string) {
    if (!path) return;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      for (const id of PROVIDER_IDS) if (typeof parsed[id] === 'string' && parsed[id]) this.keys[id] = parsed[id] as string;
    } catch { /* first run or unreadable file: keys are generated on demand */ }
  }

  get(provider: ProviderId): string {
    let key = this.keys[provider];
    if (!key) { key = this.generate(provider); this.keys[provider] = key; this.persist(); }
    return key;
  }

  rotate(provider: ProviderId): string {
    const key = this.generate(provider);
    this.keys[provider] = key;
    this.persist();
    return key;
  }

  matches(provider: ProviderId, presented: string): boolean {
    const expected = Buffer.from(this.get(provider));
    const actual = Buffer.from(presented);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  private generate(provider: ProviderId): string {
    return `sk-pgsao-${provider}-${randomBytes(24).toString('hex')}`;
  }

  private persist(): void {
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const temp = `${this.path}.tmp`;
      writeFileSync(temp, JSON.stringify(this.keys), { mode: 0o600 });
      renameSync(temp, this.path);
      try { chmodSync(this.path, 0o600); } catch { /* best effort on Windows */ }
    } catch { /* keep working in memory if the data dir is read-only */ }
  }
}
