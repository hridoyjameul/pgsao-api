import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface SessionRecord {
  id: string;
  providerSessionId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface UsageStats {
  total: number;
  byRoute: Record<string, { total: number; ok: number; error: number; avgQueueWaitMs: number | null }>;
  errorsByType: Record<string, number>;
}

export interface RequestLogEntry {
  id: string;
  sessionId?: string;
  route: 'openai' | 'anthropic';
  status: 'ok' | 'error';
  startedAt: number;
  completedAt?: number;
  errorType?: string;
  queueWaitMs?: number;
}

/**
 * SQLite-backed (PRD §17). Default (no session_id) is a pure passthrough —
 * resolveSession() called with undefined always returns { providerSessionId: undefined }
 * with no DB write, matching PRD §1.5/§6.3's stateless default.
 *
 * A caller-supplied session_id that has never been seen is auto-created on
 * first use (upsert) rather than requiring a prior POST /v1/sessions call —
 * POST/GET/DELETE /v1/sessions exist for explicit lifecycle management, not
 * as a mandatory precondition.
 */
export class SessionManager {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        provider_session_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        metadata TEXT
      );
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        route TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        error_type TEXT,
        queue_wait_ms INTEGER
      );
    `);
  }

  /** Returns the provider (Agent SDK) session id to resume, or undefined for a stateless fresh call. */
  resolveSession(sessionId: string | undefined): { providerSessionId?: string } {
    if (!sessionId) return {};
    const row = this.db.prepare('SELECT provider_session_id FROM sessions WHERE id = ?').get(sessionId) as { provider_session_id: string | null } | undefined;
    if (!row) {
      const now = Date.now();
      this.db.prepare('INSERT INTO sessions (id, provider_session_id, created_at, updated_at) VALUES (?, NULL, ?, ?)').run(sessionId, now, now);
      return {};
    }
    return { providerSessionId: row.provider_session_id ?? undefined };
  }

  /** Called after a call completes — records (or updates) the Agent SDK session id this gateway session_id now maps to. */
  attachProviderSessionId(sessionId: string, providerSessionId: string): void {
    const now = Date.now();
    this.db
      .prepare('INSERT INTO sessions (id, provider_session_id, created_at, updated_at) VALUES (?, ?, ?, ?) ' + 'ON CONFLICT(id) DO UPDATE SET provider_session_id = excluded.provider_session_id, updated_at = excluded.updated_at')
      .run(sessionId, providerSessionId, now, now);
  }

  createSession(): SessionRecord {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db.prepare('INSERT INTO sessions (id, provider_session_id, created_at, updated_at) VALUES (?, NULL, ?, ?)').run(id, now, now);
    return { id, providerSessionId: null, createdAt: now, updatedAt: now };
  }

  getSession(sessionId: string): SessionRecord | undefined {
    const row = this.db.prepare('SELECT id, provider_session_id, created_at, updated_at FROM sessions WHERE id = ?').get(sessionId) as
      | { id: string; provider_session_id: string | null; created_at: number; updated_at: number }
      | undefined;
    if (!row) return undefined;
    return { id: row.id, providerSessionId: row.provider_session_id, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  deleteSession(sessionId: string): boolean {
    const result = this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    return result.changes > 0;
  }

  recordRequest(entry: RequestLogEntry): void {
    this.db
      .prepare('INSERT INTO requests (id, session_id, route, status, started_at, completed_at, error_type, queue_wait_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(entry.id, entry.sessionId ?? null, entry.route, entry.status, entry.startedAt, entry.completedAt ?? null, entry.errorType ?? null, entry.queueWaitMs ?? null);
  }

  /** Basic usage dashboard data (PRD §22 P2.4/§28 Phase 4) — split by route, from the `requests` audit log already recorded by every call. */
  getUsageStats(): UsageStats {
    const byRouteRows = this.db.prepare('SELECT route, status, COUNT(*) as cnt, AVG(queue_wait_ms) as avg_wait FROM requests GROUP BY route, status').all() as Array<{
      route: string;
      status: string;
      cnt: number;
      avg_wait: number | null;
    }>;
    const errorTypeRows = this.db.prepare("SELECT error_type, COUNT(*) as cnt FROM requests WHERE error_type IS NOT NULL GROUP BY error_type").all() as Array<{ error_type: string; cnt: number }>;

    const byRoute: UsageStats['byRoute'] = {};
    let total = 0;
    for (const row of byRouteRows) {
      const entry = (byRoute[row.route] ??= { total: 0, ok: 0, error: 0, avgQueueWaitMs: null });
      entry.total += row.cnt;
      entry[row.status === 'ok' ? 'ok' : 'error'] += row.cnt;
      if (row.avg_wait !== null) entry.avgQueueWaitMs = Math.round(row.avg_wait);
      total += row.cnt;
    }
    const errorsByType: Record<string, number> = {};
    for (const row of errorTypeRows) errorsByType[row.error_type] = row.cnt;

    return { total, byRoute, errorsByType };
  }

  close(): void {
    this.db.close();
  }
}
