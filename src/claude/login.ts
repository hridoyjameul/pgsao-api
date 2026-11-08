import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { protectWindows } from '../chatgpt/credential-store.js';

export interface LoginCommand { file: string; args: string[] }

const URL_PATTERN = /https:\/\/\S+\/oauth\/authorize\?\S+/;
const CODE_PATTERN = /^[\x21-\x7e]{8,4096}$/;
const URL_TIMEOUT_MS = 30_000;
const FINISH_TIMEOUT_MS = 60_000;
const LOGIN_TTL_MS = 15 * 60_000;

/** The Claude Code binary the Agent SDK ships for this platform (same lookup order as the SDK itself). */
export function bundledClaudeCommand(): LoginCommand | undefined {
  const require = createRequire(import.meta.url);
  const base = `@anthropic-ai/claude-agent-sdk-${process.platform === 'linux' ? 'linux' : process.platform}-${process.arch}`;
  const candidates = process.platform === 'linux' ? [`${base}-musl`, base] : [base];
  for (const pkg of candidates) {
    try {
      const file = require.resolve(`${pkg}/claude${process.platform === 'win32' ? '.exe' : ''}`);
      if (existsSync(file)) return { file, args: [] };
    } catch { /* not installed for this platform */ }
  }
  return undefined;
}

export function isValidLoginCode(value: unknown): value is string {
  return typeof value === 'string' && CODE_PATTERN.test(value.trim());
}

interface PendingLogin {
  child: ChildProcessWithoutNullStreams;
  configDir: string;
  output: string;
  exit: Promise<number | null>;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Browser-only Claude sign-in. Runs the official `claude auth login` against a
 * fresh private config folder, hands its sign-in link to the dashboard, and
 * feeds back the code the user pastes. The finished folder becomes a
 * `config_dir` Claude account (claude/accounts.ts).
 */
export class ClaudeLoginManager {
  private readonly pending = new Map<string, PendingLogin>();
  readonly root: string;

  constructor(accountsPath: string, private readonly command: LoginCommand | undefined = bundledClaudeCommand()) {
    this.root = resolve(join(accountsPath, '..', 'claude-logins'));
  }

  get available(): boolean { return this.command !== undefined; }

  /** True for folders this manager created, which it may delete again. */
  owns(configDir: string): boolean {
    return resolve(configDir).startsWith(this.root + sep);
  }

  async start(): Promise<{ loginId: string; url: string }> {
    if (!this.command) throw new Error('Claude sign-in is not available on this system');
    const loginId = randomUUID();
    const configDir = join(this.root, loginId);
    // The parent also holds the other credential files and must be owner-only too.
    await this.ensurePrivateDir(dirname(this.root));
    await this.ensurePrivateDir(this.root);
    await this.ensurePrivateDir(configDir);

    const env: Record<string, string | undefined> = { ...process.env, CLAUDE_CONFIG_DIR: configDir, BROWSER: 'pgsao-no-browser' };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    const child = spawn(this.command.file, [...this.command.args, 'auth', 'login', '--claudeai'], { env, stdio: 'pipe', windowsHide: true });
    const login: PendingLogin = {
      child, configDir, output: '',
      exit: new Promise((done) => { child.on('exit', (code) => done(code)); child.on('error', () => done(-1)); }),
      timer: setTimeout(() => void this.cancel(loginId), LOGIN_TTL_MS),
    };
    login.timer.unref?.();
    const collect = (chunk: Buffer) => { if (login.output.length < 64_000) login.output += chunk.toString('utf8'); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    this.pending.set(loginId, login);

    const url = await new Promise<string | undefined>((done) => {
      const check = () => { const match = login.output.match(URL_PATTERN); if (match) finish(match[0]); };
      const finish = (value: string | undefined) => { clearTimeout(timeout); child.stdout.off('data', check); child.stderr.off('data', check); done(value); };
      const timeout = setTimeout(() => finish(undefined), URL_TIMEOUT_MS);
      child.stdout.on('data', check);
      child.stderr.on('data', check);
      void login.exit.then(() => finish(login.output.match(URL_PATTERN)?.[0]));
      check();
    });
    if (!url) {
      await this.cancel(loginId);
      throw new Error('Claude did not return a sign-in link');
    }
    return { loginId, url };
  }

  /** Sends the pasted code; resolves to the logged-in folder. */
  async finish(loginId: string, code: string): Promise<string> {
    const login = this.pending.get(loginId);
    if (!login) throw new Error('This sign-in expired; start again');
    if (login.child.exitCode === null) login.child.stdin.write(`${code.trim()}\n`);
    const exitCode = await Promise.race([login.exit, new Promise<'timeout'>((done) => setTimeout(() => done('timeout'), FINISH_TIMEOUT_MS).unref?.())]);
    if (exitCode !== 0) {
      await this.cancel(loginId);
      throw new Error(exitCode === 'timeout' ? 'Claude did not finish signing in' : 'Claude did not accept that code; start again and paste the newest code');
    }
    clearTimeout(login.timer);
    this.pending.delete(loginId);
    return login.configDir;
  }

  async cancel(loginId: string): Promise<void> {
    const login = this.pending.get(loginId);
    if (!login) return;
    this.pending.delete(loginId);
    clearTimeout(login.timer);
    if (login.child.exitCode === null) login.child.kill();
    await login.exit;
    await this.removeFolder(login.configDir);
  }

  async removeFolder(configDir: string): Promise<void> {
    if (this.owns(configDir)) await rm(configDir, { recursive: true, force: true }).catch(() => {});
  }

  async close(): Promise<void> {
    await Promise.all([...this.pending.keys()].map((id) => this.cancel(id)));
  }

  private async ensurePrivateDir(dir: string): Promise<void> {
    if (existsSync(dir)) return;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if (process.platform === 'win32') await protectWindows(dir);
    else await chmod(dir, 0o700);
  }
}
