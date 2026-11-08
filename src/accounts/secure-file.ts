import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { protectWindows, verifySecure } from '../chatgpt/credential-store.js';

/** A private JSON file (owner-only permissions, atomic writes, serialized mutations) for provider secrets. */
export class SecureJsonFile<T> {
  readonly path: string;
  private mutation: Promise<unknown> = Promise.resolve();

  constructor(path: string, private readonly parse: (value: unknown) => T) {
    this.path = resolve(path);
  }

  /** Undefined when the file does not exist yet. */
  async read(): Promise<T | undefined> {
    try { await lstat(this.path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    await verifySecure(dirname(this.path), true);
    await verifySecure(this.path, false);
    return this.parse(JSON.parse(await readFile(this.path, 'utf8')));
  }

  write(value: T): Promise<void> {
    return this.serialize(() => this.writeInternal(value));
  }

  /** Read-modify-write under the same serialization as write(). */
  update<R>(mutate: (current: T | undefined) => { next: T; result: R }): Promise<R> {
    return this.serialize(async () => {
      const { next, result } = mutate(await this.read());
      await this.writeInternal(next);
      return result;
    });
  }

  remove(): Promise<void> {
    return this.serialize(async () => {
      await unlink(this.path).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    });
  }

  private serialize<R>(operation: () => Promise<R>): Promise<R> {
    const run = this.mutation.then(operation);
    this.mutation = run.then(() => {}, () => {});
    return run;
  }

  private async writeInternal(value: T): Promise<void> {
    await this.ensureParent();
    const temp = join(dirname(this.path), `.pgsao-${randomUUID()}.tmp`);
    try {
      await writeFile(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
      if (process.platform === 'win32') await protectWindows(temp);
      else await chmod(temp, 0o600);
      await verifySecure(temp, false);
      await rename(temp, this.path);
      await verifySecure(this.path, false);
    } finally {
      await unlink(temp).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    }
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
