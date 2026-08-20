import type {
  AccessGrantRepositoryPort, AuditEntry, AuditLogPort, ClockPort,
  CommandGuardPort, GateCommandPort, UserRepositoryPort,
} from '../src/domain/ports.js';
import type { ClaimResult, PulseResult } from '../src/domain/gate.js';
import type { AccessGrant, User } from '../src/domain/user.js';
import type { PulseOutcome } from '@gate/shared';
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
    claim.outcome = outcome;
    if (outcome !== 'timeout') {
      claim.coolingUntil = claim.claimedAt + (claim.coolingUntil - claim.claimedAt) / UNCONFIRMED_COOLDOWN_MULTIPLIER;
    }
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
