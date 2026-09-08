import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

/**
 * First-run setup for non-developer users: creates .env from .env.example if
 * it doesn't exist yet, and generates + persists a GATEWAY_API_KEY if one
 * isn't set, so a fresh checkout works with zero manual file editing (no
 * terminal command to run, nothing to copy-paste). Idempotent — a no-op once
 * both exist.
 */
export function ensureEnvFile(path = '.env', examplePath = '.env.example'): void {
  if (!existsSync(path) && existsSync(examplePath)) {
    copyFileSync(examplePath, path);
  }
  if (!existsSync(path)) return;

  const content = readFileSync(path, 'utf-8');
  if (/^GATEWAY_API_KEY=.+$/m.test(content)) return;

  const generated = `cg_local_${randomBytes(24).toString('hex')}`;
  const updated = /^GATEWAY_API_KEY=\s*$/m.test(content)
    ? content.replace(/^GATEWAY_API_KEY=\s*$/m, `GATEWAY_API_KEY=${generated}`)
    : `${content}\nGATEWAY_API_KEY=${generated}\n`;
  writeFileSync(path, updated, 'utf-8');
}

/**
 * Minimal, dependency-free .env loader (KEY=VALUE lines, # comments,
 * optional quotes) — never overrides a var already set in the real
 * environment. Node has no built-in auto-loading; this closes a real gap
 * found while building Phase 4: `npm run dev` crashed on a fresh checkout
 * because nothing loaded .env before config.ts read process.env.
 */
export function loadDotenv(path = '.env'): void {
  ensureEnvFile(path);
  if (!existsSync(path)) return;
  const content = readFileSync(path, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
