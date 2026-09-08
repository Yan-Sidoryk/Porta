import type { ErrorCode, GatePosition, PulseOutcome, Role } from '@gate/shared';
import type { AccessGrant, PolicyDecision, User } from './user.js';
import type { ClaimResult, GateState, PulseResult, ReadingSource } from './gate.js';

export interface GateCommandPort {
  pulse(): Promise<PulseResult>;
}

export interface GateStatePort {
  getState(): Promise<GateState>;
}

/**
 * The write side of gate position, with three callers: the webhook the Shelly
 * fires on contact change, the reconciliation poll, and the trigger path.
 *
 * Split from GateStatePort because the readers and the writers are different
 * code with different rights -- the webhook route may report state and must
 * never be able to command the gate, and TriggerGateUseCase needs
 * `markUnknown` without gaining the ability to read a position it must never
 * predict from.
 */
export interface GateStateSinkPort {
  record(position: GatePosition, source: ReadingSource, at: Date): void;
  /** The gate is moving, so whatever we stored is now wrong. */
  markUnknown(): void;
}

export interface AccessPolicyPort {
  canOperate(user: User, grants: AccessGrant[], at: Date): PolicyDecision;
}

export interface CommandGuardPort {
  tryClaim(params: {
    idempotencyKey: string;
    cooldownMs: number;
    idempotencyWindowMs: number;
  }): Promise<ClaimResult>;
  release(claimId: string, outcome: PulseOutcome): Promise<void>;
}

export interface AuditEntry {
  userId: string | null;
  action: string;
  outcome: string;
  errorCode: ErrorCode | null;
  idempotencyKey: string | null;
  createdAt: Date;
  /** Redacted diagnostic detail for a failure (never raw -- see infrastructure/redact.ts). */
  detail: string | null;
}

/** Append-only. Never queried for safety decisions -- that is CommandGuardPort. */
export interface AuditLogPort {
  append(entry: AuditEntry): Promise<void>;
  listRecent(limit: number): Promise<(AuditEntry & { id: string; userEmail: string | null })[]>;
}

export interface UserRepositoryPort {
  findById(id: string): Promise<User | null>;
  findByEmail(email: string): Promise<User | null>;
  create(user: User): Promise<void>;
}

export interface AccessGrantRepositoryPort {
  listForUser(userId: string): Promise<AccessGrant[]>;
  issue(grant: AccessGrant): Promise<void>;
  revoke(grantId: string, at: Date): Promise<void>;
}

export interface TokenServicePort {
  issueAccessToken(userId: string, role: Role): string;
  verifyAccessToken(token: string): { userId: string; role: Role } | null;
  issueRefreshToken(userId: string): Promise<string>;
  consumeRefreshToken(token: string): Promise<{ userId: string } | null>;
  revokeRefreshTokensFor(userId: string): Promise<void>;
}

export interface PushToken {
  token: string;
  userId: string;
}

export interface PushTokenRepositoryPort {
  /** Re-registering the same token is an upsert, not a duplicate row. */
  save(token: PushToken, at: Date): Promise<void>;
  listAll(): Promise<PushToken[]>;
  remove(token: string): Promise<void>;
}

export interface PushSenderPort {
  /**
   * Returns the tokens the service rejected as permanently dead -- an
   * uninstalled app, mostly. The caller deletes them; without that they
   * accumulate in the table and are retried forever.
   */
  send(tokens: string[], message: { title: string; body: string }): Promise<string[]>;
}

export interface ClockPort {
  now(): Date;
}

export interface RateLimiterPort {
  /** Returns false when the caller has exhausted its budget. */
  consume(key: string, limit: number, windowMs: number): Promise<boolean>;
}
