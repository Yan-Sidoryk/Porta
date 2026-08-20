import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';
import { ROLES, type Role } from '@gate/shared';
import type { ClockPort, TokenServicePort } from '../domain/ports.js';

/** SPEC.md: short expiry. The refresh token is what keeps a session alive. */
const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** One algorithm, pinned. Accepting the token's own `alg` is how `none` gets in. */
const ALGORITHM = 'HS256';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

const isRole = (value: unknown): value is Role => ROLES.includes(value as Role);

export class JwtTokenService implements TokenServicePort {
  constructor(
    private readonly secret: string,
    private readonly db: Database.Database,
    private readonly clock: ClockPort,
  ) {}

  issueAccessToken(userId: string, role: Role): string {
    return jwt.sign({ role }, this.secret, {
      subject: userId,
      algorithm: ALGORITHM,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    });
  }

  verifyAccessToken(token: string): { userId: string; role: Role } | null {
    try {
      const claims = jwt.verify(token, this.secret, { algorithms: [ALGORITHM] });
      if (typeof claims === 'string' || typeof claims.sub !== 'string') return null;
      // A role that is not one of ours means the token was minted against a
      // different vocabulary. Reject rather than default it to something.
      return isRole(claims.role) ? { userId: claims.sub, role: claims.role } : null;
    } catch {
      return null; // bad signature, expired, malformed -- all the same answer
    }
  }

  /**
   * Refresh tokens are deliberately NOT JWTs: a JWT cannot be revoked without
   * a server-side list anyway, so the token is 32 random bytes and the list
   * IS the storage. Only the SHA-256 of it is persisted, so a leaked database
   * yields nothing usable. The raw value exists exactly once, here.
   */
  async issueRefreshToken(userId: string): Promise<string> {
    const raw = randomBytes(32).toString('base64url');
    this.db
      .prepare(
        `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(randomUUID(), userId, sha256(raw), this.clock.now().getTime() + REFRESH_TOKEN_TTL_MS);
    return raw;
  }

  /**
   * Single-use by construction: revoking IS the lookup. The UPDATE matches
   * only an unrevoked, unexpired row, and sqlite serialises writers -- so two
   * racing uses of the same stolen token cannot both come back with a user.
   * The caller issues the replacement (see RefreshSessionUseCase).
   */
  async consumeRefreshToken(token: string): Promise<{ userId: string } | null> {
    const now = this.clock.now().getTime();
    const row = this.db
      .prepare(
        `UPDATE refresh_tokens SET revoked_at = ?
         WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?
         RETURNING user_id`,
      )
      .get(now, sha256(token), now) as { user_id: string } | undefined;
    return row ? { userId: row.user_id } : null;
  }

  async revokeRefreshTokensFor(userId: string): Promise<void> {
    this.db
      .prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
      .run(this.clock.now().getTime(), userId);
  }
}
