import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { ProviderStatus } from '../providers/registry.js';
import { protectWindows, verifySecure } from '../chatgpt/credential-store.js';

const KEY_PATTERN = /^[\x21-\x7e]{8,512}$/;

export function isValidKimiKey(value: unknown): value is string {
  return typeof value === 'string' && KEY_PATTERN.test(value);
}

/** Holds the owner's Kimi Code membership key in a private file; never returned by any API. */
export class KimiKeyStore {
  readonly path: string;
  private mutation: Promise<unknown> = Promise.resolve();

  constructor(path: string) {
    this.path = resolve(path);
  }

  async load(): Promise<string | undefined> {
    try { await lstat(this.path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    await verifySecure(dirname(this.path), true);
    await verifySecure(this.path, false);
    const parsed = JSON.parse(await readFile(this.path, 'utf8')) as { apiKey?: unknown };
    if (!isValidKimiKey(parsed.apiKey)) throw new Error('Invalid Kimi credential file');
    return parsed.apiKey;
  }

  save(apiKey: string): Promise<void> {
    return this.serialize(async () => {
      await this.ensureParent();
      const temp = join(dirname(this.path), `.kimi-${randomUUID()}.tmp`);
      try {
        await writeFile(temp, JSON.stringify({ apiKey }), { flag: 'wx', mode: 0o600 });
        if (process.platform === 'win32') await protectWindows(temp);
        else await chmod(temp, 0o600);
        await verifySecure(temp, false);
        await rename(temp, this.path);
        await verifySecure(this.path, false);
      } finally {
        await unlink(temp).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
      }
    });
  }

  clear(): Promise<void> {
    return this.serialize(async () => {
      await unlink(this.path).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutation.then(operation);
    this.mutation = run.then(() => {}, () => {});
    return run;
  }

  private async ensureParent(): Promise<void> {
    const parent = dirname(this.path);
    try {
      await lstat(parent);
      await verifySecure(parent, true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(parent, { recursive: true, mode: 0o700 });
      if (process.platform === 'win32') await protectWindows(parent);
      else await chmod(parent, 0o700);
      await verifySecure(parent, true);
    }
  }
}

export class KimiConnection {
  private limitedUntil = 0;

  constructor(private readonly store: KimiKeyStore) {}

  async status(): Promise<ProviderStatus['connection']> {
    let key: string | undefined;
    try { key = await this.store.load(); } catch { return { state: 'disconnected', detail: 'Re-enter your Kimi key' }; }
    if (!key) return { state: 'not_configured' };
    const limit = this.limitedUntil > Date.now() ? ` - limit reached until ${new Date(this.limitedUntil).toLocaleTimeString()}` : '';
    return { state: 'connected', detail: `Key ending ${key.slice(-4)}${limit}` };
  }

  async getKey(): Promise<string> {
    const key = await this.store.load().catch(() => undefined);
    if (!key) throw new Error('Kimi key missing');
    return key;
  }

  saveKey(apiKey: string): Promise<void> {
    this.limitedUntil = 0;
    return this.store.save(apiKey);
  }

  removeKey(): Promise<void> {
    this.limitedUntil = 0;
    return this.store.clear();
  }

  noteLimit(retryAfterSeconds?: number): void {
    this.limitedUntil = Date.now() + (retryAfterSeconds ?? 300) * 1000;
  }
}
