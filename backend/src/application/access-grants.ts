import { randomUUID } from 'node:crypto';
import type { ErrorCode } from '@gate/shared';
import type {
  AccessGrantRepositoryPort, ClockPort, UserRepositoryPort,
} from '../domain/ports.js';

export type IssueGrantResult =
  | { ok: true; grantId: string }
  | { ok: false; code: ErrorCode };

export type RevokeGrantResult = { ok: true } | { ok: false; code: ErrorCode };

/** Owner-only, and a disabled owner is not an owner. */
async function isOwner(users: UserRepositoryPort, userId: string): Promise<boolean> {
  const user = await users.findById(userId);
  return user !== null && user.role === 'owner' && !user.disabled;
}

// No ClockPort here: an AccessGrant carries the window it was given and no
// issued-at of its own, so this use case never reads the time.
export class IssueAccessGrantUseCase {
  constructor(
    private users: UserRepositoryPort,
    private grants: AccessGrantRepositoryPort,
  ) {}

  async execute(
    issuerId: string,
    params: { userId: string; startsAt: Date; endsAt: Date },
  ): Promise<IssueGrantResult> {
    if (!(await isOwner(this.users, issuerId))) return { ok: false, code: 'ACCESS_DENIED' };
    if (!(await this.users.findById(params.userId))) return { ok: false, code: 'USER_UNKNOWN' };

    // The policy admits `startsAt <= at < endsAt`, so an inverted or empty
    // window can never grant anything. Rejecting it here means the owner
    // finds out now, rather than the guest finding out at the gate.
    if (params.startsAt.getTime() >= params.endsAt.getTime()) {
      return { ok: false, code: 'BAD_REQUEST' };
    }

    const grantId = randomUUID();
    await this.grants.issue({
      id: grantId,
      userId: params.userId,
      startsAt: params.startsAt,
      endsAt: params.endsAt,
      createdBy: issuerId,
      revokedAt: null,
    });
    return { ok: true, grantId };
  }
}

export class RevokeAccessGrantUseCase {
  constructor(
    private users: UserRepositoryPort,
    private grants: AccessGrantRepositoryPort,
    private clock: ClockPort,
  ) {}

  /**
   * Idempotent: revoking an id that does not exist reports success. The port
   * offers no way to read a single grant back, and inventing a NOT_FOUND here
   * would turn this endpoint into a probe for which grant ids are real.
   */
  async execute(revokerId: string, grantId: string): Promise<RevokeGrantResult> {
    if (!(await isOwner(this.users, revokerId))) return { ok: false, code: 'ACCESS_DENIED' };
    await this.grants.revoke(grantId, this.clock.now());
    return { ok: true };
  }
}
