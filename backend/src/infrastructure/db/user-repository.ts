import type Database from 'better-sqlite3';
import type { Role } from '@gate/shared';
import type { User } from '../../domain/user.js';
import type { UserRepositoryPort } from '../../domain/ports.js';

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  role: Role;
  disabled: number;
  created_at: number;
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    role: row.role,
    disabled: Boolean(row.disabled),
    createdAt: new Date(row.created_at),
  };
}

export class SqliteUserRepository implements UserRepositoryPort {
  constructor(private db: Database.Database) {}

  async findById(id: string): Promise<User | null> {
    const row = this.db
      .prepare('SELECT * FROM users WHERE id = ?')
      .get(id) as UserRow | undefined;
    return row ? toUser(row) : null;
  }

  async findByEmail(email: string): Promise<User | null> {
    const row = this.db
      .prepare('SELECT * FROM users WHERE email = ?')
      .get(email) as UserRow | undefined;
    return row ? toUser(row) : null;
  }

  async create(user: User): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO users (id, email, password_hash, role, disabled, created_at)
         VALUES (@id, @email, @passwordHash, @role, @disabled, @createdAt)`,
      )
      .run({
        id: user.id,
        email: user.email,
        passwordHash: user.passwordHash,
        role: user.role,
        disabled: user.disabled ? 1 : 0,
        createdAt: user.createdAt.getTime(),
      });
  }
}
