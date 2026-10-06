import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionManager } from '../src/sessions/session-manager.js';

describe('provider-aware request audit', () => {
  it('migrates old request rows to Claude and groups usage by provider without losing route totals', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pgsao-usage-'));
    const path = join(dir, 'gateway.db');
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE requests (
      id TEXT PRIMARY KEY, session_id TEXT, route TEXT NOT NULL, status TEXT NOT NULL,
      started_at INTEGER NOT NULL, completed_at INTEGER, error_type TEXT, queue_wait_ms INTEGER
    );`);
    old.prepare('INSERT INTO requests (id, route, status, started_at, queue_wait_ms) VALUES (?, ?, ?, ?, ?)').run('old-claude', 'openai', 'ok', 100, 0);
    old.close();
    try {
      const manager = new SessionManager(path);
      try {
        manager.recordRequest({ id: 'new-claude', provider: 'claude', route: 'openai', status: 'ok', startedAt: 200, queueWaitMs: 20 });
        manager.recordRequest({ id: 'kimi', provider: 'kimi', route: 'openai', status: 'error', startedAt: 300, queueWaitMs: 40, errorType: 'provider_error' });
        const stats = manager.getUsageStats();
        expect(stats.byProvider.claude).toMatchObject({ total: 2, ok: 2, error: 0, avgQueueWaitMs: 10 });
        expect(stats.byProvider.kimi).toMatchObject({ total: 1, ok: 0, error: 1, avgQueueWaitMs: 40 });
        expect(stats.byRoute.openai.total).toBe(3);
        expect(stats.byRoute.openai.avgQueueWaitMs).toBe(20);
        const db = new DatabaseSync(path);
        try {
          const columns = db.prepare('PRAGMA table_info(requests)').all() as { name: string }[];
          expect(columns.map((column) => column.name)).toContain('provider');
          expect((db.prepare('SELECT provider FROM requests WHERE id = ?').get('old-claude') as { provider: string }).provider).toBe('claude');
        } finally { db.close(); }
      } finally { manager.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
