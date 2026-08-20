import argon2 from 'argon2';

/**
 * argon2id with the library's own defaults -- they track current guidance,
 * and hand-tuned cost parameters age badly. The one thing that must not
 * change is the algorithm: SPEC.md forbids fast hashes.
 */
export const hashPassword = (plain: string): Promise<string> =>
  argon2.hash(plain, { type: argon2.argon2id });

/**
 * argon2.verify throws on a hash it cannot parse, which on the login path
 * would turn a corrupt stored row into a 500 -- and a 500 for one account
 * and a 401 for the rest is exactly the oracle SPEC.md forbids. A failure to
 * verify is a failed login, full stop.
 */
export const verifyPassword = (hash: string, plain: string): Promise<boolean> =>
  argon2.verify(hash, plain).catch(() => false);
