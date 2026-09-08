import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureEnvFile } from '../src/utils/load-dotenv.js';

describe('ensureEnvFile', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('creates .env from .env.example and fills in a generated GATEWAY_API_KEY when missing entirely', () => {
    dir = mkdtempSync(join(tmpdir(), 'pgsao-ensure-env-'));
    const envPath = join(dir, '.env');
    const examplePath = join(dir, '.env.example');
    writeFileSync(examplePath, 'PORT=8787\nGATEWAY_API_KEY=\n', 'utf-8');

    ensureEnvFile(envPath, examplePath);

    const content = readFileSync(envPath, 'utf-8');
    const match = content.match(/^GATEWAY_API_KEY=(.+)$/m);
    expect(match).not.toBeNull();
    expect(match![1]!.length).toBeGreaterThanOrEqual(16);
    expect(match![1]).toMatch(/^cg_local_/);
  });

  it('does not overwrite an existing key', () => {
    dir = mkdtempSync(join(tmpdir(), 'pgsao-ensure-env-'));
    const envPath = join(dir, '.env');
    writeFileSync(envPath, 'GATEWAY_API_KEY=already_set_value_123456\n', 'utf-8');

    ensureEnvFile(envPath, join(dir, '.env.example'));

    const content = readFileSync(envPath, 'utf-8');
    expect(content).toContain('GATEWAY_API_KEY=already_set_value_123456');
  });

  it('appends a generated key when the file exists but has no GATEWAY_API_KEY line at all', () => {
    dir = mkdtempSync(join(tmpdir(), 'pgsao-ensure-env-'));
    const envPath = join(dir, '.env');
    writeFileSync(envPath, 'PORT=8787\n', 'utf-8');

    ensureEnvFile(envPath, join(dir, '.env.example'));

    const content = readFileSync(envPath, 'utf-8');
    expect(content).toMatch(/^GATEWAY_API_KEY=cg_local_/m);
  });
});
