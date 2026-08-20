import type Database from 'better-sqlite3';
import type { AccessGrant } from '../../domain/user.js';
import type { AccessGrantRepositoryPort } from '../../domain/ports.js';

interface GrantRow {
  id: string;
  user_id: string;
  starts_at: number;
  ends_at: number;
  created_by: string;
  revoked_at: number | null;
}

function toGrant(row: GrantRow): AccessGrant {
  return {
    id: row.id,
    userId: row.user_id,
    startsAt: new Date(row.starts_at),
    endsAt: new Date(row.ends_at),
    createdBy: row.created_by,
    revokedAt: row.revoked_at === null ? null : new Date(row.revoked_at),
  };
}

export class SqliteAccessGrantRepository implements AccessGrantRepositoryPort {
  constructor(private db: Database.Database) {}

  async listForUser(userId: string): Promise<AccessGrant[]> {
    const rows = this.db
      .prepare('SELECT * FROM access_grants WHERE user_id = ?')
      .all(userId) as GrantRow[];
    return rows.map(toGrant);
  }

  async issue(grant: AccessGrant): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO access_grants (id, user_id, starts_at, ends_at, created_by, revoked_at)
         VALUES (@id, @userId, @startsAt, @endsAt, @createdBy, @revokedAt)`,
      )
      .run({
        id: grant.id,
        userId: grant.userId,
        startsAt: grant.startsAt.getTime(),
        endsAt: grant.endsAt.getTime(),
        createdBy: grant.createdBy,
        revokedAt: grant.revokedAt === null ? null : grant.revokedAt.getTime(),
      });
  }

  async revoke(grantId: string, at: Date): Promise<void> {
    this.db
      .prepare('UPDATE access_grants SET revoked_at = ? WHERE id = ?')
      .run(at.getTime(), grantId);
  }
}
