import { describe, expect, it } from 'vitest';
import { IssueAccessGrantUseCase, RevokeAccessGrantUseCase } from './access-grants.js';
import { RoleBasedAccessPolicy } from '../domain/access-policy.js';
import { FakeClock, FakeGrantRepo, FakeUserRepo } from '../../test/fakes.js';
import type { User } from '../domain/user.js';

const owner: User = {
  id: 'owner1', email: 'owner@example.com', passwordHash: 'h',
  role: 'owner', disabled: false, createdAt: new Date(0),
};
const guest: User = { ...owner, id: 'guest1', email: 'guest@example.com', role: 'user' };

const NOW = new Date('2026-08-20T12:00:00Z');
const window = { startsAt: new Date('2026-08-20T09:00:00Z'), endsAt: new Date('2026-08-20T18:00:00Z') };

const setup = (users: User[] = [owner, guest]) => {
  const clock = new FakeClock(NOW);
  const grants = new FakeGrantRepo();
  return {
    clock,
    grants,
    issue: new IssueAccessGrantUseCase(new FakeUserRepo([...users]), grants),
    revoke: new RevokeAccessGrantUseCase(new FakeUserRepo([...users]), grants, clock),
  };
};

describe('IssueAccessGrantUseCase', () => {
  it('records a grant issued by an owner', async () => {
    const { issue, grants } = setup();

    const result = await issue.execute('owner1', { userId: 'guest1', ...window });

    expect(result).toMatchObject({ ok: true });
    const stored = await grants.listForUser('guest1');
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ userId: 'guest1', createdBy: 'owner1', revokedAt: null });
  });

  it('refuses a non-owner issuer', async () => {
    const { issue, grants } = setup();
    expect(await issue.execute('guest1', { userId: 'guest1', ...window }))
      .toEqual({ ok: false, code: 'ACCESS_DENIED' });
    expect(await grants.listForUser('guest1')).toHaveLength(0);
  });

  it('refuses a disabled owner', async () => {
    const { issue } = setup([{ ...owner, disabled: true }, guest]);
    expect(await issue.execute('owner1', { userId: 'guest1', ...window }))
      .toEqual({ ok: false, code: 'ACCESS_DENIED' });
  });

  it('refuses an unknown issuer', async () => {
    const { issue } = setup();
    expect(await issue.execute('ghost', { userId: 'guest1', ...window }))
      .toEqual({ ok: false, code: 'ACCESS_DENIED' });
  });

  it('refuses a grant for a user that does not exist', async () => {
    const { issue } = setup();
    expect(await issue.execute('owner1', { userId: 'ghost', ...window }))
      .toEqual({ ok: false, code: 'USER_UNKNOWN' });
  });

  it('refuses a window that ends before it starts', async () => {
    const { issue } = setup();
    expect(await issue.execute('owner1', {
      userId: 'guest1', startsAt: window.endsAt, endsAt: window.startsAt,
    })).toEqual({ ok: false, code: 'BAD_REQUEST' });
  });

  it('refuses a zero-length window', async () => {
    // startsAt === endsAt grants nothing: the policy uses startsAt <= at < endsAt.
    const { issue } = setup();
    expect(await issue.execute('owner1', {
      userId: 'guest1', startsAt: window.startsAt, endsAt: window.startsAt,
    })).toEqual({ ok: false, code: 'BAD_REQUEST' });
  });
});

describe('RevokeAccessGrantUseCase', () => {
  const policy = new RoleBasedAccessPolicy();

  it('revokes a grant, and the policy denies immediately', async () => {
    const { issue, revoke, grants, clock } = setup();
    const issued = await issue.execute('owner1', { userId: 'guest1', ...window });
    if (!issued.ok) throw new Error('setup failed');

    expect(policy.canOperate(guest, await grants.listForUser('guest1'), clock.now()).allowed).toBe(true);

    expect(await revoke.execute('owner1', issued.grantId)).toEqual({ ok: true });

    expect(policy.canOperate(guest, await grants.listForUser('guest1'), clock.now()).allowed).toBe(false);
  });

  it('stamps the revocation with the injected clock', async () => {
    const { issue, revoke, grants, clock } = setup();
    const issued = await issue.execute('owner1', { userId: 'guest1', ...window });
    if (!issued.ok) throw new Error('setup failed');

    await revoke.execute('owner1', issued.grantId);

    const [stored] = await grants.listForUser('guest1');
    expect(stored?.revokedAt?.getTime()).toBe(clock.now().getTime());
  });

  it('refuses a non-owner revoker', async () => {
    const { issue, revoke, grants, clock } = setup();
    const issued = await issue.execute('owner1', { userId: 'guest1', ...window });
    if (!issued.ok) throw new Error('setup failed');

    expect(await revoke.execute('guest1', issued.grantId))
      .toEqual({ ok: false, code: 'ACCESS_DENIED' });

    // The grant must still be live -- a refused revoke that half-applied
    // would be worse than either outcome.
    expect(policy.canOperate(guest, await grants.listForUser('guest1'), clock.now()).allowed).toBe(true);
  });
});
