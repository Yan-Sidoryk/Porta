import { describe, expect, it } from 'vitest';
import { RoleBasedAccessPolicy } from './access-policy.js';
import type { AccessGrant, User } from './user.js';

const AT = new Date('2026-08-19T12:00:00Z');
const policy = new RoleBasedAccessPolicy();

const user = (over: Partial<User> = {}): User => ({
  id: 'u1', email: 'a@b.c', passwordHash: 'x',
  role: 'user', disabled: false, createdAt: AT, ...over,
});

const grant = (over: Partial<AccessGrant> = {}): AccessGrant => ({
  id: 'g1', userId: 'u1',
  startsAt: new Date('2026-08-19T00:00:00Z'),
  endsAt: new Date('2026-08-20T00:00:00Z'),
  createdBy: 'owner1', revokedAt: null, ...over,
});

describe('RoleBasedAccessPolicy', () => {
  it('allows an owner with no grant', () => {
    expect(policy.canOperate(user({ role: 'owner' }), [], AT).allowed).toBe(true);
  });

  it('denies a disabled owner', () => {
    expect(policy.canOperate(user({ role: 'owner', disabled: true }), [], AT).allowed).toBe(false);
  });

  it('DENIES a user with no grant at all', () => {
    expect(policy.canOperate(user(), [], AT).allowed).toBe(false);
  });

  it('allows a user inside an active grant window', () => {
    expect(policy.canOperate(user(), [grant()], AT).allowed).toBe(true);
  });

  it('DENIES a user whose grant was revoked', () => {
    const revoked = grant({ revokedAt: new Date('2026-08-19T11:00:00Z') });
    expect(policy.canOperate(user(), [revoked], AT).allowed).toBe(false);
  });

  it('denies a user before the window opens', () => {
    const future = grant({ startsAt: new Date('2026-08-19T18:00:00Z') });
    expect(policy.canOperate(user(), [future], AT).allowed).toBe(false);
  });

  it('denies a user after the window closes', () => {
    const past = grant({ endsAt: AT });
    expect(policy.canOperate(user(), [past], AT).allowed).toBe(false);
  });

  it('allows when one of several grants is active', () => {
    const past = grant({ id: 'g0', endsAt: new Date('2026-08-19T06:00:00Z') });
    expect(policy.canOperate(user(), [past, grant()], AT).allowed).toBe(true);
  });

  it('DENIES a user riding another user\'s grant', () => {
    const othersGrant = grant({ userId: 'someone-else' });
    expect(policy.canOperate(user({ id: 'u1' }), [othersGrant], AT).allowed).toBe(false);
  });
});
