import type { ErrorCode } from '@gate/shared';
import type { TokenServicePort, UserRepositoryPort } from '../domain/ports.js';

export type AuthResult =
  | { ok: true; accessToken: string; refreshToken: string }
  | { ok: false; code: ErrorCode };

/**
 * Injected rather than imported so the application layer keeps no dependency
 * on the argon2 adapter. The composition root passes infrastructure's
 * `verifyPassword`.
 */
export type VerifyPassword = (hash: string, plain: string) => Promise<boolean>;

/**
 * A real argon2id hash of a string nothing authenticates against. Verifying
 * an unknown email against THIS costs what verifying a real user costs, so a
 * stopwatch cannot answer "does this address have an account?".
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=65536,p=4,t=3$4Y6u0Pry/vQVz5AM1GnoJg$Xkx8gSShrVhFxT8fOYoCPXJ6o1AiODZxFrd+zJhPfJc';

const denied = (): AuthResult => ({ ok: false, code: 'ACCESS_DENIED' });

export class AuthenticateUserUseCase {
  constructor(
    private users: UserRepositoryPort,
    private tokens: TokenServicePort,
    private verifyPassword: VerifyPassword,
  ) {}

  async execute(email: string, password: string): Promise<AuthResult> {
    const user = await this.users.findByEmail(email);

    // Always hash, and always the same amount of it. Returning early for an
    // unknown email is the whole leak SPEC.md forbids.
    const verified = await this.verifyPassword(user?.passwordHash ?? DUMMY_HASH, password);

    // One branch, one value: unknown email, wrong password and disabled
    // account are indistinguishable from outside.
    if (!user || !verified || user.disabled) return denied();

    return {
      ok: true,
      accessToken: this.tokens.issueAccessToken(user.id, user.role),
      refreshToken: await this.tokens.issueRefreshToken(user.id),
    };
  }
}

export class RefreshSessionUseCase {
  constructor(
    private users: UserRepositoryPort,
    private tokens: TokenServicePort,
  ) {}

  async execute(refreshToken: string): Promise<AuthResult> {
    // consumeRefreshToken revokes as it reads -- rotation is only complete
    // once this method issues the replacement below.
    const consumed = await this.tokens.consumeRefreshToken(refreshToken);
    if (!consumed) return { ok: false, code: 'SESSION_EXPIRED' };

    const user = await this.users.findById(consumed.userId);
    if (!user) return { ok: false, code: 'SESSION_EXPIRED' };

    if (user.disabled) {
      // Disabling an account has to end the sessions it already has, or the
      // person keeps refreshing their way in for the token's whole lifetime.
      await this.tokens.revokeRefreshTokensFor(user.id);
      return denied();
    }

    return {
      ok: true,
      accessToken: this.tokens.issueAccessToken(user.id, user.role),
      refreshToken: await this.tokens.issueRefreshToken(user.id),
    };
  }
}
