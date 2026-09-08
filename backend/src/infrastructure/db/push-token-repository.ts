import type Database from 'better-sqlite3';
import type { PushToken, PushTokenRepositoryPort } from '../../domain/ports.js';

interface PushTokenRow {
  token: string;
  user_id: string;
}

export class SqlitePushTokenRepository implements PushTokenRepositoryPort {
  constructor(private readonly db: Database.Database) {}

  /**
   * Upsert on the token, not insert.
   *
   * Expo hands the same device the same token across launches, so a plain
   * insert would throw on every re-registration -- which happens whenever the
   * app starts with notifications already on. Re-pointing `user_id` matters
   * too: on a shared phone the token follows whoever is signed in, or the
   * previous user keeps getting alerts about a gate they may no longer be
   * allowed to open.
   */
  async save(token: PushToken, at: Date): Promise<void> {
    this.db.prepare(`
      INSERT INTO push_tokens (token, user_id, created_at)
      VALUES (@token, @userId, @createdAt)
      ON CONFLICT(token) DO UPDATE SET user_id = @userId
    `).run({ token: token.token, userId: token.userId, createdAt: at.getTime() });
  }

  async listAll(): Promise<PushToken[]> {
    const rows = this.db
      .prepare('SELECT token, user_id FROM push_tokens')
      .all() as PushTokenRow[];

    return rows.map((row) => ({ token: row.token, userId: row.user_id }));
  }

  async remove(token: string): Promise<void> {
    this.db.prepare('DELETE FROM push_tokens WHERE token = ?').run(token);
  }
}
