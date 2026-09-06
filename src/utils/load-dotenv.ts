import { existsSync, readFileSync } from 'node:fs';

/**
 * Minimal, dependency-free .env loader (KEY=VALUE lines, # comments,
 * optional quotes) — never overrides a var already set in the real
 * environment. Node has no built-in auto-loading; this closes a real gap
 * found while building Phase 4: `npm run dev` crashed on a fresh checkout
 * because nothing loaded .env before config.ts read process.env.
 */
export function loadDotenv(path = '.env'): void {
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
