import type { AccessPolicyPort } from './ports.js';
import type { AccessGrant, PolicyDecision, User } from './user.js';

/**
 * Two roles plus grants.
 *
 * SECURITY DECISION: a 'user' with no currently-valid grant is DENIED. This
 * is the default branch, not an incidental outcome -- a freshly created user
 * account can do nothing until an owner issues a grant, and a revoked grant
 * denies immediately rather than falling back to permissive behaviour.
 */
export class RoleBasedAccessPolicy implements AccessPolicyPort {
  canOperate(user: User, grants: AccessGrant[], at: Date): PolicyDecision {
    if (user.disabled) return { allowed: false, reason: 'Account is disabled' };
    if (user.role === 'owner') return { allowed: true };

    const active = grants.some(
      (g) =>
        g.userId === user.id &&
        g.revokedAt === null &&
        g.startsAt.getTime() <= at.getTime() &&
        at.getTime() < g.endsAt.getTime(),
    );

    return active
      ? { allowed: true }
      : { allowed: false, reason: 'No active access grant' };
  }
}
