import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ErrorCode } from '@gate/shared';
import type { AuditEntry, AuditLogPort } from '../../domain/ports.js';

interface AuditRow {
  id: string;
  user_id: string | null;
  action: string;
  outcome: string;
  error_code: ErrorCode | null;
  idempotency_key: string | null;
  detail: string | null;
  created_at: number;
  user_email: string | null;
}

function toEntry(row: AuditRow): AuditEntry & { id: string; userEmail: string | null } {
  return {
    id: row.id,
    userId: row.user_id,
    action: row.action,
    outcome: row.outcome,
    errorCode: row.error_code,
    idempotencyKey: row.idempotency_key,
    detail: row.detail,
    createdAt: new Date(row.created_at),
    userEmail: row.user_email,
  };
}

export class SqliteAuditLog implements AuditLogPort {
  constructor(private db: Database.Database) {}

  async append(entry: AuditEntry): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO audit_events (id, user_id, action, outcome, error_code, idempotency_key, detail, created_at)
         VALUES (@id, @userId, @action, @outcome, @errorCode, @idempotencyKey, @detail, @createdAt)`,
      )
      .run({
        id: randomUUID(),
        userId: entry.userId,
        action: entry.action,
        outcome: entry.outcome,
        errorCode: entry.errorCode,
        idempotencyKey: entry.idempotencyKey,
        detail: entry.detail,
        createdAt: entry.createdAt.getTime(),
      });
  }

  // Fetches the `limit` most recent rows, then reverses them so the result
  // reads oldest-first, newest-last -- a scrollback, not a top-N leaderboard.
  async listRecent(limit: number): Promise<(AuditEntry & { id: string; userEmail: string | null })[]> {
    const rows = this.db
      .prepare(
        `SELECT a.*, u.email AS user_email
         FROM audit_events a
         LEFT JOIN users u ON u.id = a.user_id
         ORDER BY a.created_at DESC, a.rowid DESC
         LIMIT ?`,
      )
      .all(limit) as AuditRow[];
    return rows.reverse().map(toEntry);
  }
}
