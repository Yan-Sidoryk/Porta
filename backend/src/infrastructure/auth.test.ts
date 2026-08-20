import { createHash } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { openDatabase } from './db/open.js';
import { hashPassword, verifyPassword } from './password.js';
import { JwtTokenService, REFRESH_TOKEN_TTL_MS } from './jwt.js';
import { InMemoryRateLimiter } from './rate-limiter.js';
import { SystemClock } from './clock.js';
import { FakeClock } from '../../test/fakes.js';

const SECRET = 'test-secret-at-least-32-characters-long';

const setup = () => {
  const db = openDatabase(':memory:');
  // refresh_tokens carries a foreign key to users, so the owner must exist.
  db.prepare(
    `INSERT INTO users (id, email, password_hash, role, disabled, created_at)
     VALUES ('u1', 'a@b.c', 'x', 'owner', 0, 0)`,
  ).run();
  const clock = new FakeClock();
  return { db, clock, tokens: new JwtTokenService(SECRET, db, clock) };
};

describe('password hashing', () => {
  it('verifies a password against its own hash', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true);
  });

  it('rejects the wrong password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword(hash, 'Correct horse battery staple')).toBe(false);
  });

  it('produces an argon2id hash, not a fast one', async () => {
    expect(await hashPassword('pw')).toMatch(/^\$argon2id\$/);
  });

  it('salts: the same password hashes differently every time', async () => {
    expect(await hashPassword('pw')).not.toBe(await hashPassword('pw'));
  });

  it('returns false rather than throwing on a corrupt stored hash', async () => {
    // A garbage hash must fail the login, not crash the endpoint.
    expect(await verifyPassword('not-a-hash', 'pw')).toBe(false);
  });
});

describe('JwtTokenService access tokens', () => {
  it('round-trips userId and role', () => {
    const { tokens } = setup();
    const token = tokens.issueAccessToken('u1', 'owner');
    expect(tokens.verifyAccessToken(token)).toEqual({ userId: 'u1', role: 'owner' });
  });

  it('rejects a token signed with a different secret', () => {
    const { tokens } = setup();
    const forged = jwt.sign({ role: 'owner' }, 'some-other-secret', { subject: 'u1' });
    expect(tokens.verifyAccessToken(forged)).toBeNull();
  });

  it('rejects an expired token', () => {
    const { tokens } = setup();
    const expired = jwt.sign({ role: 'owner' }, SECRET, { subject: 'u1', expiresIn: '-1s' });
    expect(tokens.verifyAccessToken(expired)).toBeNull();
  });

  it('rejects an unsigned alg:none token', () => {
    const { tokens } = setup();
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: 'u1', role: 'owner' })}.`;
    expect(tokens.verifyAccessToken(unsigned)).toBeNull();
  });

  it('accepts only the algorithm it issues, even with the right secret', () => {
    // jsonwebtoken already refuses alg:none for a string secret, so that case
    // alone cannot tell a pinned verifier from an unpinned one. This can: we
    // mint HS256 and nothing else, so an HS512 token is not ours to trust.
    const { tokens } = setup();
    const other = jwt.sign({ role: 'owner' }, SECRET, { subject: 'u1', algorithm: 'HS512' });
    expect(tokens.verifyAccessToken(other)).toBeNull();
  });

  it('rejects a token carrying an unknown role', () => {
    const { tokens } = setup();
    const odd = jwt.sign({ role: 'superuser' }, SECRET, { subject: 'u1' });
    expect(tokens.verifyAccessToken(odd)).toBeNull();
  });

  it('expires in 15 minutes', () => {
    const { tokens } = setup();
    const claims = jwt.decode(tokens.issueAccessToken('u1', 'user')) as { iat: number; exp: number };
    expect(claims.exp - claims.iat).toBe(15 * 60);
  });
});

describe('JwtTokenService refresh tokens', () => {
  it('round-trips the owning user', async () => {
    const { tokens } = setup();
    const raw = await tokens.issueRefreshToken('u1');
    expect(await tokens.consumeRefreshToken(raw)).toEqual({ userId: 'u1' });
  });

  it('is single-use: a stolen token cannot be replayed', async () => {
    const { tokens } = setup();
    const raw = await tokens.issueRefreshToken('u1');
    await tokens.consumeRefreshToken(raw);
    expect(await tokens.consumeRefreshToken(raw)).toBeNull();
  });

  it('stores only a hash, never the raw token', async () => {
    const { tokens, db } = setup();
    const raw = await tokens.issueRefreshToken('u1');
    const rows = db.prepare('SELECT token_hash FROM refresh_tokens').all() as { token_hash: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).not.toBe(raw);
    expect(rows[0]?.token_hash).toBe(createHash('sha256').update(raw).digest('hex'));
  });

  it('rejects an expired refresh token', async () => {
    const { tokens, clock } = setup();
    const raw = await tokens.issueRefreshToken('u1');
    clock.advance(REFRESH_TOKEN_TTL_MS + 1);
    expect(await tokens.consumeRefreshToken(raw)).toBeNull();
  });

  it('honours a token right up to its expiry', async () => {
    const { tokens, clock } = setup();
    const raw = await tokens.issueRefreshToken('u1');
    clock.advance(REFRESH_TOKEN_TTL_MS - 1);
    expect(await tokens.consumeRefreshToken(raw)).toEqual({ userId: 'u1' });
  });

  it('rejects an unknown token', async () => {
    const { tokens } = setup();
    expect(await tokens.consumeRefreshToken('never-issued')).toBeNull();
  });

  it('revokes every outstanding token for a user', async () => {
    const { tokens } = setup();
    const first = await tokens.issueRefreshToken('u1');
    const second = await tokens.issueRefreshToken('u1');

    await tokens.revokeRefreshTokensFor('u1');

    expect(await tokens.consumeRefreshToken(first)).toBeNull();
    expect(await tokens.consumeRefreshToken(second)).toBeNull();
  });
});

describe('InMemoryRateLimiter', () => {
  it('allows exactly `limit` calls, then denies', async () => {
    const limiter = new InMemoryRateLimiter(new FakeClock());
    const results = [];
    for (let i = 0; i < 4; i += 1) results.push(await limiter.consume('ip:1.2.3.4', 3, 60_000));
    expect(results).toEqual([true, true, true, false]);
  });

  it('counts each key separately', async () => {
    const limiter = new InMemoryRateLimiter(new FakeClock());
    expect(await limiter.consume('a', 1, 60_000)).toBe(true);
    expect(await limiter.consume('a', 1, 60_000)).toBe(false);
    expect(await limiter.consume('b', 1, 60_000)).toBe(true);
  });

  it('rolls the window over on the injected clock', async () => {
    const clock = new FakeClock();
    const limiter = new InMemoryRateLimiter(clock);

    expect(await limiter.consume('a', 1, 60_000)).toBe(true);
    expect(await limiter.consume('a', 1, 60_000)).toBe(false);

    clock.advance(59_999);
    expect(await limiter.consume('a', 1, 60_000)).toBe(false); // still inside

    clock.advance(1);
    expect(await limiter.consume('a', 1, 60_000)).toBe(true); // window rolled
  });
});

describe('SystemClock', () => {
  it('reports real time', () => {
    expect(Math.abs(new SystemClock().now().getTime() - Date.now())).toBeLessThan(1000);
  });
});
