import { describe, expect, it } from 'vitest';
import { AuthenticateUserUseCase, RefreshSessionUseCase } from './auth.js';
import { FakeTokenService, FakeUserRepo } from '../../test/fakes.js';
import type { User } from '../domain/user.js';

const owner: User = {
  id: 'u1',
  email: 'owner@example.com',
  passwordHash: 'hash-of-correct',
  role: 'owner',
  disabled: false,
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

/** Stands in for argon2: only the exact pairing below verifies. */
const setup = (users: User[] = [owner]) => {
  const verified: { hash: string; plain: string }[] = [];
  const verify = async (hash: string, plain: string) => {
    verified.push({ hash, plain });
    return hash === 'hash-of-correct' && plain === 'correct';
  };
  const tokens = new FakeTokenService();
  return {
    tokens,
    verified,
    login: new AuthenticateUserUseCase(new FakeUserRepo([...users]), tokens, verify),
    refresh: new RefreshSessionUseCase(new FakeUserRepo([...users]), tokens),
  };
};

describe('AuthenticateUserUseCase', () => {
  it('issues both tokens for the right password', async () => {
    const { login } = setup();
    const result = await login.execute('owner@example.com', 'correct');
    expect(result).toEqual({
      ok: true,
      accessToken: 'access:u1:owner',
      refreshToken: expect.stringContaining('refresh:u1'),
    });
  });

  it('answers identically for a wrong password and an unknown email', async () => {
    const { login } = setup();
    const wrongPassword = await login.execute('owner@example.com', 'wrong');
    const unknownEmail = await login.execute('nobody@example.com', 'correct');

    expect(wrongPassword).toEqual({ ok: false, code: 'ACCESS_DENIED' });
    expect(unknownEmail).toEqual(wrongPassword);
  });

  it('still verifies a password when the email is unknown', async () => {
    // The observable half of "takes a comparable path": skipping the hash for
    // an unknown email makes the response time an account-existence oracle.
    const { login, verified } = setup();
    await login.execute('nobody@example.com', 'correct');
    expect(verified).toHaveLength(1);
    expect(verified[0]?.hash).toMatch(/^\$argon2id\$/);
  });

  it('denies a disabled user with the same answer', async () => {
    const { login } = setup([{ ...owner, disabled: true }]);
    expect(await login.execute('owner@example.com', 'correct'))
      .toEqual({ ok: false, code: 'ACCESS_DENIED' });
  });

  it('issues no token to a disabled user', async () => {
    const { login, tokens } = setup([{ ...owner, disabled: true }]);
    await login.execute('owner@example.com', 'correct');
    expect(await tokens.consumeRefreshToken('refresh:u1:1')).toBeNull();
  });
});

describe('RefreshSessionUseCase', () => {
  it('exchanges a live refresh token for a new pair', async () => {
    const { refresh, tokens } = setup();
    const first = await tokens.issueRefreshToken('u1');

    const result = await refresh.execute(first);

    expect(result).toMatchObject({ ok: true, accessToken: 'access:u1:owner' });
    if (!result.ok) throw new Error('unreachable');
    expect(result.refreshToken).not.toBe(first); // rotated, not handed back
  });

  it('completes the rotation: the old token is dead after use', async () => {
    const { refresh, tokens } = setup();
    const first = await tokens.issueRefreshToken('u1');
    await refresh.execute(first);
    expect(await refresh.execute(first)).toEqual({ ok: false, code: 'SESSION_EXPIRED' });
  });

  it('rejects a token that was never issued', async () => {
    const { refresh } = setup();
    expect(await refresh.execute('made-up')).toEqual({ ok: false, code: 'SESSION_EXPIRED' });
  });

  it('rejects a token whose user no longer exists', async () => {
    const { refresh, tokens } = setup([]);
    const orphan = await tokens.issueRefreshToken('deleted-user');
    expect(await refresh.execute(orphan)).toEqual({ ok: false, code: 'SESSION_EXPIRED' });
  });

  it('denies a disabled user and kills their remaining sessions', async () => {
    const { refresh, tokens } = setup([{ ...owner, disabled: true }]);
    const used = await tokens.issueRefreshToken('u1');
    const other = await tokens.issueRefreshToken('u1');

    expect(await refresh.execute(used)).toEqual({ ok: false, code: 'ACCESS_DENIED' });

    // Disabling an account must end sessions already open, not merely stop
    // new logins -- otherwise a revoked person keeps refreshing for 30 days.
    expect(tokens.revokedFor).toContain('u1');
    expect(await tokens.consumeRefreshToken(other)).toBeNull();
  });
});
