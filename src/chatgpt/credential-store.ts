import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { chmod, lstat, mkdir, readFile, rename, rmdir, unlink, writeFile } from 'node:fs/promises';

const run = promisify(execFile);
const SYSTEM_SID = 'S-1-5-18';
const ADMIN_SID = 'S-1-5-32-544';

export interface ChatGptAccount {
  registrationId: string;
  clientId: string;
  issuer: string;
  subject: string;
  email?: string;
  planType?: string;
  scopes: string[];
  accessToken: string;
  refreshToken: string;
  idToken: string;
  expiresAt: number;
}

export interface ChatGptStoreState {
  hostId: string;
  selectedRegistrationId?: string;
  accounts: ChatGptAccount[];
}

export function defaultChatGptCredentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === 'win32') return join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'PGSAO API', 'chatgpt.json');
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'pgsao-api', 'chatgpt.json');
}

function validateState(value: unknown): ChatGptStoreState {
  if (!value || typeof value !== 'object') throw new Error('Invalid ChatGPT credential file');
  const state = value as Record<string, unknown>;
  if (typeof state.hostId !== 'string' || !/^urn:uuid:[0-9a-f-]{36}$/i.test(state.hostId)
    || !Array.isArray(state.accounts) || (state.selectedRegistrationId !== undefined && typeof state.selectedRegistrationId !== 'string')) {
    throw new Error('Invalid ChatGPT credential file');
  }
  for (const item of state.accounts) {
    if (!item || typeof item !== 'object') throw new Error('Invalid ChatGPT credential file');
    const a = item as Record<string, unknown>;
    if (['registrationId', 'clientId', 'issuer', 'subject', 'accessToken', 'refreshToken', 'idToken'].some((k) => typeof a[k] !== 'string')
      || (a.planType !== undefined && typeof a.planType !== 'string')
      || !Array.isArray(a.scopes) || !a.scopes.every((s: unknown) => typeof s === 'string') || typeof a.expiresAt !== 'number') {
      throw new Error('Invalid ChatGPT credential file');
    }
  }
  return value as ChatGptStoreState;
}

let userSidPromise: Promise<string> | undefined;
async function currentUserSid(): Promise<string> {
  userSidPromise ??= run('whoami', ['/user', '/fo', 'csv', '/nh']).then(({ stdout }) => {
    const sid = stdout.match(/S-1-5-\d+(?:-\d+)+/i)?.[0];
    if (!sid) throw new Error('Cannot identify Windows user for ChatGPT credential protection');
    return sid;
  });
  return userSidPromise;
}

export async function protectWindows(path: string): Promise<void> {
  const sid = await currentUserSid();
  await run('icacls', [path, '/inheritance:r', '/grant:r', `*${sid}:(F)`, `*${SYSTEM_SID}:(F)`, `*${ADMIN_SID}:(F)`]);
  const entries = await windowsAclEntries(path);
  for (const entry of entries) {
    const principal = entry?.split(';;;')[1];
    if (principal && !new Set([sid, 'SY', 'BA']).has(principal)) {
      await run('icacls', [path, '/remove:g', `*${principal}`, '/remove:d', `*${principal}`]);
    }
  }
  await verifyWindows(path, sid);
}

async function windowsAclEntries(path: string): Promise<string[]> {
  const dump = join(tmpdir(), `pgsao-acl-${randomUUID()}.txt`);
  try {
    await run('icacls', [path, '/save', dump]);
    const sddl = (await readFile(dump)).toString('utf16le').split(/\r?\n/)[1] ?? '';
    if (!sddl.startsWith('D:P')) throw new Error('Insecure ChatGPT credential permissions');
    return [...sddl.matchAll(/\(([^)]*)\)/g)].map((match) => match[1] ?? '');
  } finally {
    await unlink(dump).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function verifyWindows(path: string, expectedSid?: string): Promise<void> {
  const sid = expectedSid ?? await currentUserSid();
  const entries = await windowsAclEntries(path);
  const allowed = new Set([`A;;FA;;;${sid}`, 'A;;FA;;;SY', 'A;;FA;;;BA']);
  if (entries.length === 0 || entries.some((entry) => !allowed.has(entry))) {
    throw new Error('Insecure ChatGPT credential permissions');
  }
}

export async function verifySecure(path: string, directory: boolean): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) throw new Error('Insecure ChatGPT credential path');
  if (process.platform === 'win32') await verifyWindows(path);
  else if ((info.mode & (directory ? 0o077 : 0o177)) !== 0) throw new Error('Insecure ChatGPT credential permissions');
}

export class ChatGptCredentialStore {
  readonly path: string;
  private mutation = Promise.resolve();

  constructor(path = defaultChatGptCredentialsPath()) {
    this.path = resolve(path);
  }

  async load(): Promise<ChatGptStoreState> {
    const parent = dirname(this.path);
    try { await lstat(this.path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        try { await lstat(parent); await verifySecure(parent, true); } catch (parentError) {
          if ((parentError as NodeJS.ErrnoException).code !== 'ENOENT') throw parentError;
        }
        return { hostId: '', accounts: [] };
      }
      throw error;
    }
    await verifySecure(parent, true);
    await verifySecure(this.path, false);
    return validateState(JSON.parse(await readFile(this.path, 'utf8')));
  }

  async save(state: ChatGptStoreState): Promise<void> {
    const operation = this.mutation.then(() => this.withFileLock(() => this.saveInternal(validateState(state))));
    this.mutation = operation.then(() => {}, () => {});
    return operation;
  }

  async update<T>(mutate: (state: ChatGptStoreState) => T | Promise<T>): Promise<T> {
    const operation = this.mutation.then(() => this.withFileLock(async () => {
      const state = await this.load();
      const result = await mutate(state);
      await this.saveInternal(validateState(state));
      return result;
    }));
    this.mutation = operation.then(() => {}, () => {});
    return operation;
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

  private async withFileLock<T>(operation: () => Promise<T>): Promise<T> {
    await this.ensureParent();
    const lockDir = `${this.path}.lock`;
    const deadline = Date.now() + 30_000;
    while (true) {
      try {
        await mkdir(lockDir, { mode: 0o700 });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (Date.now() >= deadline) throw new Error('ChatGPT credential store is busy');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    try {
      if (process.platform === 'win32') await protectWindows(lockDir);
      else await chmod(lockDir, 0o700);
      await verifySecure(lockDir, true);
      return await operation();
    } finally { await rmdir(lockDir); }
  }

  private async saveInternal(state: ChatGptStoreState): Promise<void> {
    await this.ensureParent();
    const parent = dirname(this.path);
    try { await verifySecure(this.path, false); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const temp = join(parent, `.chatgpt-${randomUUID()}.tmp`);
    try {
      await writeFile(temp, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
      if (process.platform === 'win32') await protectWindows(temp);
      else await chmod(temp, 0o600);
      await verifySecure(temp, false);
      await rename(temp, this.path);
      await verifySecure(this.path, false);
    } finally {
      await unlink(temp).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  async getOrCreateHostId(): Promise<string> {
    const state = await this.load();
    if (state.hostId) return state.hostId;
    return this.update((latest) => {
      latest.hostId ||= `urn:uuid:${randomUUID()}`;
      return latest.hostId;
    });
  }
}
