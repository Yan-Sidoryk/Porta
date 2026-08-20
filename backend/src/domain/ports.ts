import type { ErrorCode, PulseOutcome, Role } from '@gate/shared';
import type { AccessGrant, PolicyDecision, User } from './user.js';
import type { ClaimResult, GateState, PulseResult } from './gate.js';

export interface GateCommandPort {
  pulse(): Promise<PulseResult>;
}

export interface GateStatePort {
  getState(): Promise<GateState>;
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

export interface ClockPort {
  now(): Date;
}

export interface RateLimiterPort {
  /** Returns false when the caller has exhausted its budget. */
  consume(key: string, limit: number, windowMs: number): Promise<boolean>;
}
