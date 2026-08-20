import type {
  AccessGrantRepositoryPort, AuditEntry, AuditLogPort, ClockPort,
  CommandGuardPort, GateCommandPort, GateStatePort, TokenServicePort,
  UserRepositoryPort,
} from '../src/domain/ports.js';
import type { ClaimResult, GateState, PulseResult } from '../src/domain/gate.js';
import type { AccessGrant, User } from '../src/domain/user.js';
import type { PulseOutcome, Role } from '@gate/shared';
import { UNCONFIRMED_COOLDOWN_MULTIPLIER } from '../src/domain/constants.js';

export class FakeClock implements ClockPort {
  constructor(private current = new Date('2026-08-19T12:00:00Z')) {}
  now(): Date { return this.current; }
  advance(ms: number): void { this.current = new Date(this.current.getTime() + ms); }
}

export class FakeGateCommand implements GateCommandPort {
  calls = 0;
  constructor(private result: PulseResult = { outcome: 'success' }) {}
  setResult(r: PulseResult): void { this.result = r; }
  async pulse(): Promise<PulseResult> { this.calls += 1; return this.result; }
}

/** Mirrors SqliteCommandGuard semantics: pessimistic 2x claim, narrowed on release. */
export class FakeGuard implements CommandGuardPort {
  private claims: { id: string; key: string; claimedAt: number; coolingUntil: number; outcome: PulseOutcome | null }[] = [];
  private seq = 0;
  /** For tests: counts every call to release(), regardless of whether the claimId matched. */
  releaseCalls = 0;
  constructor(private clock: FakeClock) {}

  async tryClaim(p: { idempotencyKey: string; cooldownMs: number; idempotencyWindowMs: number }): Promise<ClaimResult> {
    const now = this.clock.now().getTime();
    const replay = this.claims.find(
      (c) => c.key === p.idempotencyKey && c.claimedAt > now - p.idempotencyWindowMs,
    );
    if (replay) return { kind: 'replayed', outcome: replay.outcome ?? 'pending' };

    const cooling = this.claims.filter((c) => c.coolingUntil > now)
      .sort((a, b) => b.coolingUntil - a.coolingUntil)[0];
    if (cooling) return { kind: 'cooling-down', retryAfterMs: cooling.coolingUntil - now };

    const id = `claim-${++this.seq}`;
    this.claims.push({
      id, key: p.idempotencyKey, claimedAt: now,
      coolingUntil: now + p.cooldownMs * UNCONFIRMED_COOLDOWN_MULTIPLIER, outcome: null,
    });
    return { kind: 'granted', claimId: id };
  }

  async release(claimId: string, outcome: PulseOutcome): Promise<void> {
    this.releaseCalls += 1;
    const claim = this.claims.find((c) => c.id === claimId);
    if (!claim) return;
    // Once-only, mirroring the SQLite guard's `AND outcome IS NULL`: the first
    // outcome recorded wins. Narrowing twice would halve the window.
    if (claim.outcome !== null) return;
    claim.outcome = outcome;
    if (outcome !== 'timeout') {
      claim.coolingUntil = claim.claimedAt + (claim.coolingUntil - claim.claimedAt) / UNCONFIRMED_COOLDOWN_MULTIPLIER;
    }
  }
}

export class FakeGateState implements GateStatePort {
  /** An Error here is thrown instead of returned -- adapters do fail. */
  constructor(private result: GateState | Error = { position: 'unknown', reachable: true, checkedAt: new Date(0) }) {}
  setResult(r: GateState | Error): void { this.result = r; }
  async getState(): Promise<GateState> {
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

/**
 * Mirrors JwtTokenService where it matters: a refresh token is single-use and
 * revoking a user's tokens invalidates the ones already handed out. Access
 * tokens are plain strings -- signature checking is the real service's job and
 * is tested against it directly in infrastructure/auth.test.ts.
 *
 * ACCEPTED GAP: unlike CommandGuardPort, no shared contract test binds this to
 * JwtTokenService, so the two can drift. Tolerated because single-use is
 * proven directly against the real implementation, and RefreshSessionUseCase
 * only distinguishes null from non-null -- no use-case logic depends on the
 * replay behaviour asserted here.
 *
 * Write the contract test (mirror test/command-guard-contract.ts) if either
 * happens: TokenServicePort gains a method, or a second real implementation
 * appears. Until then, changing the semantics below without changing
 * JwtTokenService makes the auth tests describe a service that does not exist.
 */
export class FakeTokenService implements TokenServicePort {
  revokedFor: string[] = [];
  private live = new Map<string, string>();
  private seq = 0;

  issueAccessToken(userId: string, role: Role): string { return `access:${userId}:${role}`; }

  verifyAccessToken(token: string): { userId: string; role: Role } | null {
    const [prefix, userId, role] = token.split(':');
    return prefix === 'access' && userId && role ? { userId, role: role as Role } : null;
  }

  async issueRefreshToken(userId: string): Promise<string> {
    const raw = `refresh:${userId}:${++this.seq}`;
    this.live.set(raw, userId);
    return raw;
  }

  async consumeRefreshToken(token: string): Promise<{ userId: string } | null> {
    const userId = this.live.get(token);
    if (!userId) return null;
    this.live.delete(token); // single-use, like the real one
    return { userId };
  }

  async revokeRefreshTokensFor(userId: string): Promise<void> {
    this.revokedFor.push(userId);
    for (const [raw, owner] of this.live) if (owner === userId) this.live.delete(raw);
  }
}

export class FakeUserRepo implements UserRepositoryPort {
  constructor(private users: User[] = []) {}
  async findById(id: string): Promise<User | null> { return this.users.find((u) => u.id === id) ?? null; }
  async findByEmail(email: string): Promise<User | null> { return this.users.find((u) => u.email === email) ?? null; }
  async create(u: User): Promise<void> { this.users.push(u); }
}

export class FakeGrantRepo implements AccessGrantRepositoryPort {
  constructor(private grants: AccessGrant[] = []) {}
  async listForUser(userId: string): Promise<AccessGrant[]> { return this.grants.filter((g) => g.userId === userId); }
  async issue(g: AccessGrant): Promise<void> { this.grants.push(g); }
  async revoke(id: string, at: Date): Promise<void> {
    const g = this.grants.find((x) => x.id === id);
    if (g) g.revokedAt = at;
  }
}

export class FakeAuditLog implements AuditLogPort {
  entries: AuditEntry[] = [];
  async append(e: AuditEntry): Promise<void> { this.entries.push(e); }
  async listRecent(limit: number) {
    return this.entries.slice(-limit).map((e, i) => ({ ...e, id: `a${i}`, userEmail: null }));
  }
}
