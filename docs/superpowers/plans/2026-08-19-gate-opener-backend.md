# Smart Gate Opener — Implementation Plan (Milestones 1–5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working backend that pulses a physical gate relay safely, plus a thin Expo slice proving login and trigger work end to end against a stubbed Shelly.

**Architecture:** Hexagonal. `domain/` holds entities, ten port interfaces, and typed errors with zero outward imports; `application/` holds use cases depending only on ports; `infrastructure/` holds adapters; `api/` holds thin Fastify routes. A single `composition-root.ts` is the only file naming a concrete adapter. The safety-critical logic is a claim-before-call command guard backed by an atomic SQLite transaction.

**Tech Stack:** Node 20+ (dev machine runs 25.2.1), TypeScript strict, Fastify, better-sqlite3, Zod, argon2, Vitest, Expo/React Native.

**Spec:** `docs/superpowers/specs/2026-08-19-gate-opener-design.md` — read it before starting. This plan argues from it; where they disagree, the spec wins and you should stop and flag it.

## Global Constraints

- **Node 20+**, TypeScript **strict mode** everywhere. No `any` in committed code.
- **`SHELLY_AUTH_KEY` never leaves the backend.** Not in `/app`, not in `/shared`, not in logs, not in an error response, not in a test fixture.
- **No hardcoded `5000`.** The cooldown comes from `GATE_COOLDOWN_MS` in the environment. The idempotency window is a named constant, `IDEMPOTENCY_WINDOW_MS = 60_000`.
- **No test calls the real Shelly API.** Every one would move a real gate.
- **Never retry a pulse.** Not on timeout, not on failure, nowhere in the stack.
- **`ClockPort` is injected wherever time is read.** `Date.now()` never appears inside `domain/` or `application/`.
- **No DI framework.** Wire by hand in the composition root.
- Dependencies point inward. `domain/` imports nothing from `application/`, `infrastructure/`, or `api/`.
- **Every safety-critical invariant must be proven by mutation.** Before a test
  covering one of these counts as passing, break the implementation
  deliberately, watch the test fail, then revert and watch it pass. A test that
  has never failed has told you nothing. The invariants: cooldown ordering
  (claim before call), claim atomicity, the pessimistic-2x-narrowed-on-evidence
  window, audit-on-rejection, and no-retry-on-timeout. Record the mutation and
  the resulting failure in the task report.

## Shared Type Vocabulary

These names are used across many tasks. Define them once in Task 1/2 exactly as written; later tasks assume these exact spellings.

```ts
type Role = 'owner' | 'user';
type GatePosition = 'open' | 'closed' | 'unknown';

// The persisted result of one pulse attempt. Anything other than 'timeout'
// is a CONFIRMED outcome and narrows the cooldown to 1x.
type PulseOutcome =
  | 'success'
  | 'timeout'
  | 'device-offline'
  | 'device-failed'
  | 'bad-request'
  | 'device-not-found'
  | 'error';

type ErrorCode =
  | 'GATE_COOLING_DOWN' | 'ATTEMPT_IN_PROGRESS' | 'DEVICE_OFFLINE'
  | 'TIMEOUT_AMBIGUOUS' | 'ACCESS_DENIED' | 'SESSION_EXPIRED'
  | 'RATE_LIMITED' | 'DEVICE_FAILED_COMMAND' | 'BAD_REQUEST'
  | 'DEVICE_NOT_FOUND' | 'USER_UNKNOWN' | 'USER_DISABLED' | 'INTERNAL';
```

## File Structure

```
package.json                     npm workspaces root
shared/src/api.ts                Zod schemas + inferred request/response types
shared/src/vocabulary.ts         Role, GatePosition, PulseOutcome, ErrorCode

backend/src/domain/errors.ts             ErrorCode + DomainError
backend/src/domain/user.ts               User entity, AccessGrant entity
backend/src/domain/gate.ts               GateState, PulseResult, PulseOutcome
backend/src/domain/ports.ts              All ten port interfaces
backend/src/domain/access-policy.ts      RoleBasedAccessPolicy (pure)
backend/src/domain/constants.ts          IDEMPOTENCY_WINDOW_MS + rationale

backend/src/application/trigger-gate.ts      TriggerGateUseCase
backend/src/application/audited-trigger.ts   AuditedTriggerGate decorator
backend/src/application/auth.ts              Authenticate + RefreshSession
backend/src/application/gate-status.ts       GetGateStatusUseCase
backend/src/application/audit-events.ts      ListAuditEventsUseCase
backend/src/application/access-grants.ts     Issue + Revoke

backend/src/infrastructure/db/schema.sql     Tables + indexes
backend/src/infrastructure/db/open.ts        better-sqlite3 open + migrate
backend/src/infrastructure/db/*-repository.ts
backend/src/infrastructure/db/command-guard.ts   SqliteCommandGuard (critical)
backend/src/infrastructure/shelly/*.ts           Command + state adapters
backend/src/infrastructure/{jwt,password,clock,rate-limiter}.ts

backend/src/api/routes/*.ts          Thin Fastify routes
backend/src/composition-root.ts      The only file naming concrete adapters
backend/src/config.ts                Env parsing + boot-time refusal
backend/scripts/create-user.ts       First-user CLI

app/                                 Expo, thin slice only in this plan
```

---

### Task 1: Workspace scaffold and shared contract

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `.env.example`
- Create: `shared/package.json`, `shared/tsconfig.json`, `shared/src/vocabulary.ts`, `shared/src/api.ts`
- Create: `backend/package.json`, `backend/tsconfig.json`, `backend/vitest.config.ts`
- Test: `shared/src/api.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `@gate/shared` exporting `Role`, `GatePosition`, `PulseOutcome`, `ErrorCode`, `TriggerRequestSchema`, `TriggerResponseSchema`, `LoginRequestSchema`, `LoginResponseSchema`, `GateStatusResponseSchema`, `AuditEventSchema`, and their inferred types.

- [ ] **Step 1: Create the workspace root**

`package.json`:
```json
{
  "name": "gate-opener",
  "private": true,
  "workspaces": ["shared", "backend"],
  "scripts": {
    "test": "npm run test --workspaces --if-present",
    "typecheck": "npm run typecheck --workspaces --if-present"
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "declaration": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  }
}
```

- [ ] **Step 2: Create `.env.example` with placeholders only**

```
SHELLY_HOST=shelly-XX-eu.shelly.cloud
SHELLY_AUTH_KEY=replace-me-never-commit-the-real-one
SHELLY_DEVICE_ID=replace-me
JWT_SECRET=replace-me-min-32-chars
GATE_COOLDOWN_MS=5000
DATABASE_PATH=./gate.db
PUBLIC_URL=http://localhost:3000
NODE_ENV=development
```

Verify `.env` is already gitignored (it is — the repo root `.gitignore` lists it). Never copy real values into `.env.example`.

- [ ] **Step 3: Write the failing test for the shared contract**

`shared/src/api.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { TriggerRequestSchema, TriggerResponseSchema } from './api.js';

describe('TriggerRequestSchema', () => {
  it('requires a uuid idempotency key', () => {
    expect(TriggerRequestSchema.safeParse({ idempotencyKey: 'nope' }).success).toBe(false);
    expect(
      TriggerRequestSchema.safeParse({
        idempotencyKey: '3f6d1c8e-9b2a-4c5d-8e1f-0a2b3c4d5e6f',
      }).success,
    ).toBe(true);
  });
});

describe('TriggerResponseSchema', () => {
  it('carries retryAfterMs on a cooldown rejection', () => {
    const parsed = TriggerResponseSchema.parse({
      ok: false,
      code: 'GATE_COOLING_DOWN',
      message: 'Cooling down',
      retryAfterMs: 4200,
    });
    expect(parsed).toMatchObject({ ok: false, retryAfterMs: 4200 });
  });

  it('rejects an unknown error code', () => {
    const bad = TriggerResponseSchema.safeParse({
      ok: false, code: 'MADE_UP', message: 'x',
    });
    expect(bad.success).toBe(false);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npm test -w shared`
Expected: FAIL — cannot resolve `./api.js`.

- [ ] **Step 5: Implement the shared vocabulary and schemas**

`shared/src/vocabulary.ts`:
```ts
export const ROLES = ['owner', 'user'] as const;
export type Role = (typeof ROLES)[number];

export const GATE_POSITIONS = ['open', 'closed', 'unknown'] as const;
export type GatePosition = (typeof GATE_POSITIONS)[number];

export const PULSE_OUTCOMES = [
  'success', 'timeout', 'device-offline', 'device-failed',
  'bad-request', 'device-not-found', 'error',
] as const;
export type PulseOutcome = (typeof PULSE_OUTCOMES)[number];

export const ERROR_CODES = [
  'GATE_COOLING_DOWN', 'ATTEMPT_IN_PROGRESS', 'DEVICE_OFFLINE',
  'TIMEOUT_AMBIGUOUS', 'ACCESS_DENIED', 'SESSION_EXPIRED',
  'RATE_LIMITED', 'DEVICE_FAILED_COMMAND', 'BAD_REQUEST',
  'DEVICE_NOT_FOUND', 'USER_UNKNOWN', 'USER_DISABLED', 'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** A confirmed outcome narrows the cooldown; 'timeout' does not. */
export const isConfirmedOutcome = (o: PulseOutcome): boolean => o !== 'timeout';
```

`shared/src/api.ts`:
```ts
import { z } from 'zod';
import { ERROR_CODES, GATE_POSITIONS, PULSE_OUTCOMES } from './vocabulary.js';

export const TriggerRequestSchema = z.object({
  idempotencyKey: z.string().uuid(),
});

export const TriggerResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    outcome: z.enum(PULSE_OUTCOMES),
    replayed: z.boolean(),
  }),
  z.object({
    ok: z.literal(false),
    code: z.enum(ERROR_CODES),
    message: z.string(),
    retryAfterMs: z.number().int().nonnegative().optional(),
  }),
]);

export const LoginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const LoginResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
});

export const GateStatusResponseSchema = z.object({
  position: z.enum(GATE_POSITIONS),
  reachable: z.boolean(),
  checkedAt: z.string().datetime(),
});

export const AuditEventSchema = z.object({
  id: z.string(),
  userEmail: z.string().nullable(),
  action: z.string(),
  outcome: z.string(),
  errorCode: z.enum(ERROR_CODES).nullable(),
  createdAt: z.string().datetime(),
});

export type TriggerRequest = z.infer<typeof TriggerRequestSchema>;
export type TriggerResponse = z.infer<typeof TriggerResponseSchema>;
export type LoginRequest = z.infer<typeof LoginRequestSchema>;
export type LoginResponse = z.infer<typeof LoginResponseSchema>;
export type GateStatusResponse = z.infer<typeof GateStatusResponseSchema>;
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export * from './vocabulary.js';
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -w shared` → PASS. Then `npm run typecheck --workspaces`.

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.base.json .env.example shared backend/package.json backend/tsconfig.json backend/vitest.config.ts
git commit -m "feat: workspace scaffold and shared API contract"
```

---

### Task 2: Domain entities, errors, and ports

**Files:**
- Create: `backend/src/domain/errors.ts`, `user.ts`, `gate.ts`, `ports.ts`, `constants.ts`
- Test: `backend/src/domain/gate.test.ts`

**Interfaces:**
- Consumes: `@gate/shared` vocabulary types.
- Produces: all ten port interfaces, `DomainError`, `User`, `AccessGrant`, `GateState`, `PulseResult`, `ClaimResult`, `PolicyDecision`, `IDEMPOTENCY_WINDOW_MS`.

- [ ] **Step 1: Write the constants with their rationale**

`backend/src/domain/constants.ts`:
```ts
/**
 * How long a single idempotency key is honoured as a replay.
 *
 * The app generates one UUID per user-initiated tap and reuses it across
 * network retries. Within this window the same key returns the original
 * result instead of sending a second pulse. Fixed by the spec; not
 * environment-configurable.
 */
export const IDEMPOTENCY_WINDOW_MS = 60_000;

/**
 * Multiplier applied to GATE_COOLDOWN_MS at claim time.
 *
 * The window is written pessimistically (2x) before the pulse is attempted
 * and narrowed to 1x only when the outcome is CONFIRMED. An attempt whose
 * fate we do not know -- a timeout, or a process that died before releasing
 * its claim -- therefore holds the LONGER window. Writing 1x up front and
 * extending on timeout would invert this: an abandoned claim would get a
 * weaker guard than a timeout despite carrying strictly less information.
 */
export const UNCONFIRMED_COOLDOWN_MULTIPLIER = 2;
```

- [ ] **Step 2: Write the domain errors and entities**

`backend/src/domain/errors.ts`:
```ts
import type { ErrorCode } from '@gate/shared';

export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
```

`backend/src/domain/user.ts`:
```ts
import type { Role } from '@gate/shared';

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  role: Role;
  disabled: boolean;
  createdAt: Date;
}

export interface AccessGrant {
  id: string;
  userId: string;
  startsAt: Date;
  endsAt: Date;
  createdBy: string;
  revokedAt: Date | null;
}

export type PolicyDecision =
  | { allowed: true }
  | { allowed: false; reason: string };
```

`backend/src/domain/gate.ts`:
```ts
import type { GatePosition, PulseOutcome } from '@gate/shared';

export interface GateState {
  position: GatePosition;
  reachable: boolean;
  checkedAt: Date;
}

export interface PulseResult {
  outcome: PulseOutcome;
  /** Raw device detail, for the audit log only. Never returned to the app. */
  detail?: string;
}

export type ClaimResult =
  | { kind: 'granted'; claimId: string }
  | { kind: 'cooling-down'; retryAfterMs: number }
  | { kind: 'replayed'; outcome: PulseOutcome | 'pending' };
```

- [ ] **Step 3: Write the ports**

`backend/src/domain/ports.ts`:
```ts
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
```

- [ ] **Step 4: Write a test proving the domain layer has no outward imports**

`backend/src/domain/gate.test.ts`:
```ts
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IDEMPOTENCY_WINDOW_MS, UNCONFIRMED_COOLDOWN_MULTIPLIER } from './constants.js';

describe('domain layer', () => {
  it('imports nothing from outer layers', () => {
    const dir = import.meta.dirname;
    const offenders: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const src = readFileSync(join(dir, file), 'utf8');
      if (/from '\.\.\/(application|infrastructure|api)\//.test(src)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('holds the longer window for unconfirmed attempts', () => {
    expect(UNCONFIRMED_COOLDOWN_MULTIPLIER).toBe(2);
    expect(IDEMPOTENCY_WINDOW_MS).toBe(60_000);
  });
});
```

- [ ] **Step 5: Run tests**

Run: `npm test -w backend` → PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/domain
git commit -m "feat: domain entities, errors, and ten ports"
```

---

### Task 3: RoleBasedAccessPolicy

**Files:**
- Create: `backend/src/domain/access-policy.ts`
- Test: `backend/src/domain/access-policy.test.ts`

**Interfaces:**
- Consumes: `AccessPolicyPort`, `User`, `AccessGrant`, `PolicyDecision` from Task 2.
- Produces: `class RoleBasedAccessPolicy implements AccessPolicyPort`.

- [ ] **Step 1: Write the failing tests**

`backend/src/domain/access-policy.test.ts`:
```ts
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
    const past = grant({ endsAt: new Date('2026-08-19T06:00:00Z') });
    expect(policy.canOperate(user(), [past], AT).allowed).toBe(false);
  });

  it('allows when one of several grants is active', () => {
    const past = grant({ id: 'g0', endsAt: new Date('2026-08-19T06:00:00Z') });
    expect(policy.canOperate(user(), [past, grant()], AT).allowed).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w backend -- access-policy` → FAIL, module not found.

- [ ] **Step 3: Implement**

`backend/src/domain/access-policy.ts`:
```ts
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
```

- [ ] **Step 4: Run tests** → all 8 PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/domain/access-policy.ts backend/src/domain/access-policy.test.ts
git commit -m "feat: role-based access policy, deny by default without a grant"
```

---

### Task 4: TriggerGateUseCase and in-memory fakes

**Files:**
- Create: `backend/src/application/trigger-gate.ts`
- Create: `backend/test/fakes.ts`
- Test: `backend/src/application/trigger-gate.test.ts`

**Interfaces:**
- Consumes: all ports from Task 2, `RoleBasedAccessPolicy` from Task 3.
- Produces: `interface TriggerGate { execute(userId: string, idempotencyKey: string): Promise<TriggerResult> }`, `class TriggerGateUseCase implements TriggerGate`, and `test/fakes.ts` exporting `FakeClock`, `FakeGuard`, `FakeGateCommand`, `FakeUserRepo`, `FakeGrantRepo`, `FakeAuditLog`.

- [ ] **Step 1: Write the fakes**

`backend/test/fakes.ts`:
```ts
import type {
  AccessGrantRepositoryPort, AuditEntry, AuditLogPort, ClockPort,
  CommandGuardPort, GateCommandPort, UserRepositoryPort,
} from '../src/domain/ports.js';
import type { ClaimResult, PulseResult } from '../src/domain/gate.js';
import type { AccessGrant, User } from '../src/domain/user.js';
import type { PulseOutcome } from '@gate/shared';

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
    this.claims.push({ id, key: p.idempotencyKey, claimedAt: now, coolingUntil: now + p.cooldownMs * 2, outcome: null });
    return { kind: 'granted', claimId: id };
  }

  async release(claimId: string, outcome: PulseOutcome): Promise<void> {
    const claim = this.claims.find((c) => c.id === claimId);
    if (!claim) return;
    claim.outcome = outcome;
    if (outcome !== 'timeout') {
      claim.coolingUntil = claim.claimedAt + (claim.coolingUntil - claim.claimedAt) / 2;
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
```

- [ ] **Step 2: Write the failing tests**

`backend/src/application/trigger-gate.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { TriggerGateUseCase } from './trigger-gate.js';
import { RoleBasedAccessPolicy } from '../domain/access-policy.js';
import { FakeAuditLog, FakeClock, FakeGateCommand, FakeGrantRepo, FakeGuard, FakeUserRepo } from '../../test/fakes.js';
import type { User } from '../domain/user.js';

const COOLDOWN = 5000;
const KEY = '3f6d1c8e-9b2a-4c5d-8e1f-0a2b3c4d5e6f';
const KEY2 = '11111111-2222-3333-4444-555555555555';

const owner: User = {
  id: 'owner1', email: 'o@x.c', passwordHash: 'h',
  role: 'owner', disabled: false, createdAt: new Date('2026-01-01'),
};

let clock: FakeClock, guard: FakeGuard, gate: FakeGateCommand, useCase: TriggerGateUseCase;

beforeEach(() => {
  clock = new FakeClock();
  guard = new FakeGuard(clock);
  gate = new FakeGateCommand();
  useCase = new TriggerGateUseCase(
    new FakeUserRepo([owner]), new FakeGrantRepo([]),
    new RoleBasedAccessPolicy(), guard, gate, clock, COOLDOWN,
  );
});

describe('TriggerGateUseCase', () => {
  it('pulses once for an owner', async () => {
    const r = await useCase.execute('owner1', KEY);
    expect(r).toEqual({ ok: true, outcome: 'success', replayed: false });
    expect(gate.calls).toBe(1);
  });

  it('rejects an unknown user without pulsing', async () => {
    const r = await useCase.execute('nobody', KEY);
    expect(r).toMatchObject({ ok: false, code: 'USER_UNKNOWN' });
    expect(gate.calls).toBe(0);
  });

  it('rejects a user with no grant without pulsing', async () => {
    const u: User = { ...owner, id: 'u2', role: 'user' };
    const uc = new TriggerGateUseCase(
      new FakeUserRepo([u]), new FakeGrantRepo([]),
      new RoleBasedAccessPolicy(), guard, gate, clock, COOLDOWN,
    );
    const r = await uc.execute('u2', KEY);
    expect(r).toMatchObject({ ok: false, code: 'ACCESS_DENIED' });
    expect(gate.calls).toBe(0);
  });

  it('rejects a second tap inside the cooldown', async () => {
    await useCase.execute('owner1', KEY);
    clock.advance(2000);
    const r = await useCase.execute('owner1', KEY2);
    expect(r).toMatchObject({ ok: false, code: 'GATE_COOLING_DOWN' });
    expect(r).toHaveProperty('retryAfterMs');
    expect(gate.calls).toBe(1);
  });

  it('replays an identical key without a second pulse', async () => {
    const first = await useCase.execute('owner1', KEY);
    const second = await useCase.execute('owner1', KEY);
    expect(second).toEqual({ ...first, replayed: true });
    expect(gate.calls).toBe(1);
  });

  it('propagates DEVICE_OFFLINE', async () => {
    gate.setResult({ outcome: 'device-offline' });
    const r = await useCase.execute('owner1', KEY);
    expect(r).toMatchObject({ ok: false, code: 'DEVICE_OFFLINE' });
  });

  // THE critical safety test.
  it('rejects an immediate retry after a TIMEOUT, and holds the DOUBLED window', async () => {
    gate.setResult({ outcome: 'timeout' });
    const first = await useCase.execute('owner1', KEY);
    expect(first).toMatchObject({ ok: false, code: 'TIMEOUT_AMBIGUOUS' });
    expect(gate.calls).toBe(1);

    clock.advance(1000);
    const second = await useCase.execute('owner1', KEY2);
    expect(second).toMatchObject({ ok: false, code: 'GATE_COOLING_DOWN' });
    expect(gate.calls).toBe(1);

    // Still cooling at 6s -- proves the 2x window, not 1x.
    clock.advance(5000);
    const third = await useCase.execute('owner1', '99999999-8888-7777-6666-555555555555');
    expect(third).toMatchObject({ ok: false, code: 'GATE_COOLING_DOWN' });
    expect(gate.calls).toBe(1);
  });

  it('narrows to the 1x window after a confirmed success', async () => {
    await useCase.execute('owner1', KEY);
    clock.advance(COOLDOWN + 1);
    const r = await useCase.execute('owner1', KEY2);
    expect(r).toMatchObject({ ok: true });
    expect(gate.calls).toBe(2);
  });

  it('reports ATTEMPT_IN_PROGRESS when replaying an unreleased claim', async () => {
    const slow = new TriggerGateUseCase(
      new FakeUserRepo([owner]), new FakeGrantRepo([]),
      new RoleBasedAccessPolicy(), guard, gate, clock, COOLDOWN,
    );
    await guard.tryClaim({ idempotencyKey: KEY, cooldownMs: COOLDOWN, idempotencyWindowMs: 60_000 });
    const r = await slow.execute('owner1', KEY);
    expect(r).toMatchObject({ ok: false, code: 'ATTEMPT_IN_PROGRESS' });
    expect(gate.calls).toBe(0);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npm test -w backend -- trigger-gate` → FAIL, module not found.

- [ ] **Step 4: Implement the use case**

`backend/src/application/trigger-gate.ts`:
```ts
import type { ErrorCode, PulseOutcome } from '@gate/shared';
import type {
  AccessGrantRepositoryPort, AccessPolicyPort, ClockPort,
  CommandGuardPort, GateCommandPort, UserRepositoryPort,
} from '../domain/ports.js';
import { IDEMPOTENCY_WINDOW_MS } from '../domain/constants.js';

export type TriggerResult =
  | { ok: true; outcome: PulseOutcome; replayed: boolean }
  | { ok: false; code: ErrorCode; retryAfterMs?: number };

export interface TriggerGate {
  execute(userId: string, idempotencyKey: string): Promise<TriggerResult>;
}

const OUTCOME_TO_CODE: Record<Exclude<PulseOutcome, 'success'>, ErrorCode> = {
  timeout: 'TIMEOUT_AMBIGUOUS',
  'device-offline': 'DEVICE_OFFLINE',
  'device-failed': 'DEVICE_FAILED_COMMAND',
  'bad-request': 'BAD_REQUEST',
  'device-not-found': 'DEVICE_NOT_FOUND',
  error: 'INTERNAL',
};

const toResult = (outcome: PulseOutcome, replayed: boolean): TriggerResult =>
  outcome === 'success'
    ? { ok: true, outcome, replayed }
    : { ok: false, code: OUTCOME_TO_CODE[outcome] };

export class TriggerGateUseCase implements TriggerGate {
  constructor(
    private users: UserRepositoryPort,
    private grants: AccessGrantRepositoryPort,
    private policy: AccessPolicyPort,
    private guard: CommandGuardPort,
    private gate: GateCommandPort,
    private clock: ClockPort,
    private cooldownMs: number,
  ) {}

  async execute(userId: string, idempotencyKey: string): Promise<TriggerResult> {
    const user = await this.users.findById(userId);
    if (!user) return { ok: false, code: 'USER_UNKNOWN' };
    if (user.disabled) return { ok: false, code: 'USER_DISABLED' };

    const at = this.clock.now();
    const decision = this.policy.canOperate(user, await this.grants.listForUser(userId), at);
    if (!decision.allowed) return { ok: false, code: 'ACCESS_DENIED' };

    // Claim BEFORE calling. If the pulse timestamp were recorded only after
    // Shelly responds, the cooldown would be blind for the whole duration of
    // that in-flight request -- exactly the window it exists to protect.
    const claim = await this.guard.tryClaim({
      idempotencyKey,
      cooldownMs: this.cooldownMs,
      idempotencyWindowMs: IDEMPOTENCY_WINDOW_MS,
    });

    if (claim.kind === 'cooling-down') {
      return { ok: false, code: 'GATE_COOLING_DOWN', retryAfterMs: claim.retryAfterMs };
    }
    if (claim.kind === 'replayed') {
      return claim.outcome === 'pending'
        ? { ok: false, code: 'ATTEMPT_IN_PROGRESS' }
        : toResult(claim.outcome, true);
    }

    const result = await this.gate.pulse();
    await this.guard.release(claim.claimId, result.outcome);
    return toResult(result.outcome, false);
  }
}
```

- [ ] **Step 5: Run tests** → all 9 PASS.

- [ ] **Step 6: Prove the safety tests by mutation**

A test that has never failed has told you nothing. Run all three mutations,
confirm the named tests fail, revert after each, and record the observed
failures in your report.

| Mutation | Must fail |
|---|---|
| Move the `guard.tryClaim` call to *after* `gate.pulse()` | `rejects a second tap inside the cooldown` |
| In `FakeGuard.tryClaim`, write `now + p.cooldownMs` (1x) instead of 2x | `rejects an immediate retry after a TIMEOUT` |
| Delete the `claim.kind === 'replayed'` branch | `replays an identical key without a second pulse` |

If any mutation leaves the suite green, the test is not testing what it claims
— fix the test before continuing.

- [ ] **Step 7: Commit**

```bash
git add backend/src/application/trigger-gate.ts backend/src/application/trigger-gate.test.ts backend/test/fakes.ts
git commit -m "feat: TriggerGateUseCase with claim-before-call guard"
```

---

### Task 5: Auditing decorator

**Files:**
- Create: `backend/src/application/audited-trigger.ts`
- Test: `backend/src/application/audited-trigger.test.ts`

**Interfaces:**
- Consumes: `TriggerGate`, `TriggerResult` from Task 4; `AuditLogPort`, `ClockPort`.
- Produces: `class AuditedTriggerGate implements TriggerGate`.

- [ ] **Step 1: Write the failing tests**

`backend/src/application/audited-trigger.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { AuditedTriggerGate } from './audited-trigger.js';
import type { TriggerGate, TriggerResult } from './trigger-gate.js';
import { FakeAuditLog, FakeClock } from '../../test/fakes.js';

const KEY = '3f6d1c8e-9b2a-4c5d-8e1f-0a2b3c4d5e6f';
const stub = (r: TriggerResult): TriggerGate => ({ execute: async () => r });

describe('AuditedTriggerGate', () => {
  it('audits a success', async () => {
    const log = new FakeAuditLog();
    const g = new AuditedTriggerGate(stub({ ok: true, outcome: 'success', replayed: false }), log, new FakeClock());
    await g.execute('u1', KEY);
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]).toMatchObject({ userId: 'u1', outcome: 'success', errorCode: null });
  });

  // The reason auditing is a wrapper: these paths return EARLY.
  it('audits an access denial', async () => {
    const log = new FakeAuditLog();
    const g = new AuditedTriggerGate(stub({ ok: false, code: 'ACCESS_DENIED' }), log, new FakeClock());
    await g.execute('u1', KEY);
    expect(log.entries[0]).toMatchObject({ outcome: 'denied', errorCode: 'ACCESS_DENIED' });
  });

  it('audits an unknown user', async () => {
    const log = new FakeAuditLog();
    const g = new AuditedTriggerGate(stub({ ok: false, code: 'USER_UNKNOWN' }), log, new FakeClock());
    await g.execute('ghost', KEY);
    expect(log.entries[0]).toMatchObject({ userId: 'ghost', errorCode: 'USER_UNKNOWN' });
  });

  it('audits an unexpected throw and rethrows it', async () => {
    const log = new FakeAuditLog();
    const boom: TriggerGate = { execute: async () => { throw new Error('kaboom'); } };
    const g = new AuditedTriggerGate(boom, log, new FakeClock());
    await expect(g.execute('u1', KEY)).rejects.toThrow('kaboom');
    expect(log.entries[0]).toMatchObject({ outcome: 'error', errorCode: 'INTERNAL' });
  });

  it('records the idempotency key', async () => {
    const log = new FakeAuditLog();
    const g = new AuditedTriggerGate(stub({ ok: true, outcome: 'success', replayed: false }), log, new FakeClock());
    await g.execute('u1', KEY);
    expect(log.entries[0]?.idempotencyKey).toBe(KEY);
  });
});
```

- [ ] **Step 2: Run to verify failure** → FAIL, module not found.

- [ ] **Step 3: Implement**

`backend/src/application/audited-trigger.ts`:
```ts
import type { AuditLogPort, ClockPort } from '../domain/ports.js';
import type { TriggerGate, TriggerResult } from './trigger-gate.js';

/**
 * Auditing wraps the use case rather than sitting at the end of it.
 *
 * TriggerGateUseCase returns EARLY for an unknown user and for a denied
 * policy check -- the attempts the spec calls most important. An audit write
 * placed as the last statement of that method would never run for them.
 * Wrapping guarantees every path in and out is recorded by construction,
 * not by remembering to call the logger on each branch.
 */
export class AuditedTriggerGate implements TriggerGate {
  constructor(
    private inner: TriggerGate,
    private audit: AuditLogPort,
    private clock: ClockPort,
  ) {}

  async execute(userId: string, idempotencyKey: string): Promise<TriggerResult> {
    // Defaults to the throw case. Overwritten only on a normal return, so an
    // exception escaping `inner` is still recorded as an error rather than
    // silently skipping the audit write.
    let recorded: { outcome: string; errorCode: ErrorCode | null } = {
      outcome: 'error',
      errorCode: 'INTERNAL',
    };

    try {
      const result = await this.inner.execute(userId, idempotencyKey);
      recorded = result.ok
        ? { outcome: result.replayed ? 'replayed' : result.outcome, errorCode: null }
        : {
            outcome: result.code === 'ACCESS_DENIED' || result.code === 'USER_UNKNOWN'
              ? 'denied'
              : 'failed',
            errorCode: result.code,
          };
      return result;
    } finally {
      await this.audit.append({
        userId,
        action: 'gate.trigger',
        outcome: recorded.outcome,
        errorCode: recorded.errorCode,
        idempotencyKey,
        createdAt: this.clock.now(),
      });
    }
  }
}
```

Add `import type { ErrorCode } from '@gate/shared';` at the top.

- [ ] **Step 4: Run tests** → all 5 PASS.

- [ ] **Step 5: Prove the audit-on-rejection invariant by mutation**

| Mutation | Must fail |
|---|---|
| Move the `audit.append` out of `finally` into the `try`, after the return | `audits an unexpected throw and rethrows it` |
| Guard the append with `if (result.ok)` | `audits an access denial` and `audits an unknown user` |

Revert both. Record the observed failures in your report.

- [ ] **Step 6: Commit**

```bash
git add backend/src/application/audited-trigger.ts backend/src/application/audited-trigger.test.ts
git commit -m "feat: auditing decorator covering early rejections"
```

---

### Task 6: SQLite schema, connection, and repositories

**Files:**
- Create: `backend/src/infrastructure/db/schema.sql`, `open.ts`, `user-repository.ts`, `grant-repository.ts`, `audit-log.ts`
- Test: `backend/src/infrastructure/db/repositories.test.ts`

**Interfaces:**
- Consumes: `UserRepositoryPort`, `AccessGrantRepositoryPort`, `AuditLogPort` from Task 2.
- Produces: `openDatabase(path: string): Database`, `SqliteUserRepository`, `SqliteAccessGrantRepository`, `SqliteAuditLog`.

- [ ] **Step 1: Write the schema**

`backend/src/infrastructure/db/schema.sql`:
```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'user')),
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS access_grants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_grants_user ON access_grants(user_id);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL,
  error_code TEXT,
  idempotency_key TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_key ON audit_events(idempotency_key);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(user_id);

-- Grows one row per gate attempt, never pruned. At household volume this is
-- a few hundred KB a year; if it ever mattered, DELETE WHERE claimed_at < ?
-- is safe because a claim older than the idempotency window has no effect.
CREATE TABLE IF NOT EXISTS command_claims (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  cooling_until INTEGER NOT NULL,
  outcome TEXT
);
CREATE INDEX IF NOT EXISTS idx_claims_claimed ON command_claims(claimed_at);
CREATE INDEX IF NOT EXISTS idx_claims_key ON command_claims(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_claims_cooling ON command_claims(cooling_until);
```

- [ ] **Step 2: Write the failing repository tests**

`backend/src/infrastructure/db/repositories.test.ts` — use an in-memory database (`openDatabase(':memory:')`). Cover: create-then-find-by-email round trip; `findByEmail` returns null for a miss; grant issue/list/revoke sets `revokedAt`; audit `append` then `listRecent` returns newest-last with the user's email joined; a `Date` written survives the round trip as a `Date` (not a number).

```ts
import { describe, expect, it } from 'vitest';
import { openDatabase } from './open.js';
import { SqliteUserRepository } from './user-repository.js';
import { SqliteAuditLog } from './audit-log.js';

const setup = () => {
  const db = openDatabase(':memory:');
  return { db, users: new SqliteUserRepository(db), audit: new SqliteAuditLog(db) };
};

describe('SqliteUserRepository', () => {
  it('round-trips a user', async () => {
    const { users } = setup();
    const createdAt = new Date('2026-08-19T12:00:00Z');
    await users.create({ id: 'u1', email: 'a@b.c', passwordHash: 'h', role: 'owner', disabled: false, createdAt });
    const found = await users.findByEmail('a@b.c');
    expect(found?.id).toBe('u1');
    expect(found?.disabled).toBe(false);
    expect(found?.createdAt).toBeInstanceOf(Date);
    expect(found?.createdAt.getTime()).toBe(createdAt.getTime());
  });

  it('returns null for an unknown email', async () => {
    const { users } = setup();
    expect(await users.findByEmail('nobody@x.c')).toBeNull();
  });
});

describe('SqliteAuditLog', () => {
  it('appends and lists with the user email joined', async () => {
    const { users, audit } = setup();
    await users.create({ id: 'u1', email: 'a@b.c', passwordHash: 'h', role: 'owner', disabled: false, createdAt: new Date() });
    await audit.append({ userId: 'u1', action: 'gate.trigger', outcome: 'success', errorCode: null, idempotencyKey: 'k', createdAt: new Date() });
    const recent = await audit.listRecent(10);
    expect(recent).toHaveLength(1);
    expect(recent[0]?.userEmail).toBe('a@b.c');
  });

  it('tolerates a null user id for unknown-user attempts', async () => {
    const { audit } = setup();
    await audit.append({ userId: null, action: 'gate.trigger', outcome: 'denied', errorCode: 'USER_UNKNOWN', idempotencyKey: 'k', createdAt: new Date() });
    expect((await audit.listRecent(10))[0]?.userEmail).toBeNull();
  });
});
```

- [ ] **Step 3: Run to verify failure** → FAIL, module not found.

- [ ] **Step 4: Implement `open.ts` and the three repositories**

`open.ts` reads `schema.sql` from disk and calls `db.exec(...)` on every open — the statements are all `IF NOT EXISTS`, so this doubles as the migration. Store all timestamps as `INTEGER` epoch-ms; convert with `new Date(row.created_at)` on read and `date.getTime()` on write. Convert `disabled` with `Boolean(row.disabled)` and `x ? 1 : 0`. Each repository takes the `Database` in its constructor and implements only its port's methods.

- [ ] **Step 5: Run tests** → PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/infrastructure/db
git commit -m "feat: sqlite schema and repositories"
```

---

### Task 7: SqliteCommandGuard — the atomic claim

This is the safety-critical task. Read §4.1 and §4.2 of the spec again before starting.

**Files:**
- Create: `backend/src/infrastructure/db/command-guard.ts`
- Test: `backend/src/infrastructure/db/command-guard.test.ts`

**Interfaces:**
- Consumes: `CommandGuardPort`, `ClaimResult` from Task 2; `openDatabase` from Task 6.
- Produces: `class SqliteCommandGuard implements CommandGuardPort`, constructed as `new SqliteCommandGuard(db, clock)`.

- [ ] **Step 1: Write the failing tests**

`backend/src/infrastructure/db/command-guard.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from './open.js';
import { SqliteCommandGuard } from './command-guard.js';
import { FakeClock } from '../../../test/fakes.js';

const COOLDOWN = 5000;
const WINDOW = 60_000;
const P = (idempotencyKey: string) => ({ idempotencyKey, cooldownMs: COOLDOWN, idempotencyWindowMs: WINDOW });

let clock: FakeClock, guard: SqliteCommandGuard;

beforeEach(() => {
  clock = new FakeClock();
  guard = new SqliteCommandGuard(openDatabase(':memory:'), clock);
});

describe('SqliteCommandGuard', () => {
  it('grants a first claim', async () => {
    expect((await guard.tryClaim(P('k1'))).kind).toBe('granted');
  });

  it('writes the PESSIMISTIC 2x window at claim time', async () => {
    await guard.tryClaim(P('k1'));
    clock.advance(COOLDOWN + 100);          // past 1x, inside 2x
    const r = await guard.tryClaim(P('k2'));
    expect(r.kind).toBe('cooling-down');
  });

  it('narrows to 1x on a confirmed outcome', async () => {
    const c = await guard.tryClaim(P('k1'));
    if (c.kind !== 'granted') throw new Error('expected granted');
    await guard.release(c.claimId, 'success');
    clock.advance(COOLDOWN + 100);
    expect((await guard.tryClaim(P('k2'))).kind).toBe('granted');
  });

  it('narrows to 1x on a confirmed FAILURE too', async () => {
    const c = await guard.tryClaim(P('k1'));
    if (c.kind !== 'granted') throw new Error('expected granted');
    await guard.release(c.claimId, 'device-offline');
    clock.advance(COOLDOWN + 100);
    expect((await guard.tryClaim(P('k2'))).kind).toBe('granted');
  });

  it('leaves the 2x window intact on a timeout', async () => {
    const c = await guard.tryClaim(P('k1'));
    if (c.kind !== 'granted') throw new Error('expected granted');
    await guard.release(c.claimId, 'timeout');
    clock.advance(COOLDOWN + 100);
    expect((await guard.tryClaim(P('k2'))).kind).toBe('cooling-down');
    clock.advance(COOLDOWN);                 // now past 2x
    expect((await guard.tryClaim(P('k3'))).kind).toBe('granted');
  });

  it('holds the 2x window for an ABANDONED claim, never released', async () => {
    await guard.tryClaim(P('k1'));           // no release at all
    clock.advance(COOLDOWN + 100);
    expect((await guard.tryClaim(P('k2'))).kind).toBe('cooling-down');
  });

  it('reports retryAfterMs counting down', async () => {
    await guard.tryClaim(P('k1'));
    clock.advance(1000);
    const r = await guard.tryClaim(P('k2'));
    if (r.kind !== 'cooling-down') throw new Error('expected cooling-down');
    expect(r.retryAfterMs).toBe(COOLDOWN * 2 - 1000);
  });

  it('replays a released key with its original outcome', async () => {
    const c = await guard.tryClaim(P('k1'));
    if (c.kind !== 'granted') throw new Error('expected granted');
    await guard.release(c.claimId, 'success');
    expect(await guard.tryClaim(P('k1'))).toEqual({ kind: 'replayed', outcome: 'success' });
  });

  it('replays an in-flight key as pending', async () => {
    await guard.tryClaim(P('k1'));
    expect(await guard.tryClaim(P('k1'))).toEqual({ kind: 'replayed', outcome: 'pending' });
  });

  it('stops replaying once the idempotency window lapses', async () => {
    const c = await guard.tryClaim(P('k1'));
    if (c.kind !== 'granted') throw new Error('expected granted');
    await guard.release(c.claimId, 'success');
    clock.advance(WINDOW + 1);
    expect((await guard.tryClaim(P('k1'))).kind).toBe('granted');
  });

  it('prefers replay over cooldown for the same key', async () => {
    await guard.tryClaim(P('k1'));
    clock.advance(500);                      // inside the cooldown
    expect((await guard.tryClaim(P('k1'))).kind).toBe('replayed');
  });
});
```

- [ ] **Step 2: Run to verify failure** → FAIL, module not found.

- [ ] **Step 3: Implement**

`backend/src/infrastructure/db/command-guard.ts`:
```ts
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { PulseOutcome } from '@gate/shared';
import type { ClaimResult } from '../../domain/gate.js';
import type { ClockPort, CommandGuardPort } from '../../domain/ports.js';
import { UNCONFIRMED_COOLDOWN_MULTIPLIER } from '../../domain/constants.js';

interface ClaimRow { id: string; claimed_at: number; cooling_until: number; outcome: string | null }

export class SqliteCommandGuard implements CommandGuardPort {
  constructor(private db: Database.Database, private clock: ClockPort) {}

  async tryClaim(p: {
    idempotencyKey: string; cooldownMs: number; idempotencyWindowMs: number;
  }): Promise<ClaimResult> {
    const now = this.clock.now().getTime();

    // IMMEDIATE takes the write lock at transaction START, so the read and
    // the insert cannot interleave with a concurrent claim. A plain
    // read-then-write would let two simultaneous taps both observe "no
    // active cooldown" and both pulse -- stopping the gate mid-travel.
    const claim = this.db.transaction((): ClaimResult => {
      const replay = this.db
        .prepare<[string, number], ClaimRow>(
          `SELECT id, claimed_at, cooling_until, outcome FROM command_claims
            WHERE idempotency_key = ? AND claimed_at > ?
            ORDER BY claimed_at DESC LIMIT 1`,
        )
        .get(p.idempotencyKey, now - p.idempotencyWindowMs);

      // Idempotency is evaluated BEFORE cooldown: a retry carrying the same
      // key is the same command, not a second one.
      if (replay) {
        return {
          kind: 'replayed',
          outcome: (replay.outcome as PulseOutcome | null) ?? 'pending',
        };
      }

      const cooling = this.db
        .prepare<[number], { cooling_until: number }>(
          `SELECT cooling_until FROM command_claims
            WHERE cooling_until > ? ORDER BY cooling_until DESC LIMIT 1`,
        )
        .get(now);

      if (cooling) {
        return { kind: 'cooling-down', retryAfterMs: cooling.cooling_until - now };
      }

      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO command_claims (id, idempotency_key, claimed_at, cooling_until, outcome)
           VALUES (?, ?, ?, ?, NULL)`,
        )
        // Pessimistic by default: 2x until an outcome is known. See
        // UNCONFIRMED_COOLDOWN_MULTIPLIER for why this is not 1x.
        .run(id, p.idempotencyKey, now, now + p.cooldownMs * UNCONFIRMED_COOLDOWN_MULTIPLIER);

      return { kind: 'granted', claimId: id };
    });

    return claim.immediate();
  }

  async release(claimId: string, outcome: PulseOutcome): Promise<void> {
    // A confirmed outcome NARROWS the window to 1x. 'timeout' leaves it at
    // the pessimistic 2x written at claim time -- the pulse may well have
    // been delivered, and we have less information than usual.
    if (outcome === 'timeout') {
      this.db.prepare(`UPDATE command_claims SET outcome = ? WHERE id = ?`).run(outcome, claimId);
      return;
    }
    this.db
      .prepare(
        `UPDATE command_claims
            SET outcome = ?,
                cooling_until = claimed_at + (cooling_until - claimed_at) / ?
          WHERE id = ?`,
      )
      .run(outcome, UNCONFIRMED_COOLDOWN_MULTIPLIER, claimId);
  }
}
```

- [ ] **Step 4: Run tests** → all 11 PASS.

- [ ] **Step 5: Prove the pessimism is load-bearing**

Temporarily change the `INSERT` to write `now + p.cooldownMs` (1x). Re-run. The `abandoned claim` and `pessimistic 2x` tests MUST fail. Revert the change and confirm they pass again. This proves the tests actually guard the inversion rather than passing incidentally.

- [ ] **Step 6: Commit**

```bash
git add backend/src/infrastructure/db/command-guard.ts backend/src/infrastructure/db/command-guard.test.ts
git commit -m "feat: atomic sqlite command guard, pessimistic until confirmed"
```

---

### Task 8: Shelly adapters and the stubbed-server integration test

**Files:**
- Create: `backend/src/infrastructure/shelly/client.ts`, `gate-command-adapter.ts`, `state-adapter.ts`
- Test: `backend/src/infrastructure/shelly/shelly.integration.test.ts`

**Interfaces:**
- Consumes: `GateCommandPort`, `GateStatePort`, `PulseResult`, `GateState`, `ClockPort`.
- Produces: `ShellyCloudGateCommandAdapter`, `UnknownPositionStateAdapter`, both constructed with `(config: ShellyConfig, clock: ClockPort)` where:

```ts
export interface ShellyConfig {
  host: string;
  authKey: string;
  deviceId: string;
  timeoutMs: number;
  /** Test-only: build http:// instead of https://, so the stub server can be
   *  reached on 127.0.0.1. Never set in production config. */
  insecure?: boolean;
}
```

- [ ] **Step 1: Write the failing integration test**

Spin up a real `node:http` server on port 0, point the adapter at it, and assert the exact request shape. No mocking library needed.

`backend/src/infrastructure/shelly/shelly.integration.test.ts`:
```ts
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { ShellyCloudGateCommandAdapter } from './gate-command-adapter.js';
import { FakeClock } from '../../../test/fakes.js';

let server: Server;
afterEach(() => server?.close());

const start = (handler: (body: unknown, url: string) => { status: number; json: unknown }) =>
  new Promise<{ host: string; seen: { body: unknown; url: string }[] }>((resolve) => {
    const seen: { body: unknown; url: string }[] = [];
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        seen.push({ body, url: req.url ?? '' });
        const { status, json } = handler(body, req.url ?? '');
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(json));
      });
    }).listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (typeof addr === 'string' || addr === null) throw new Error('no address');
      resolve({ host: `127.0.0.1:${addr.port}`, seen });
    });
  });

const config = (host: string) => ({
  host, authKey: 'test-key-not-real', deviceId: 'testdevice', timeoutMs: 5000, insecure: true,
});

describe('ShellyCloudGateCommandAdapter', () => {
  it('sends the exact documented request shape', async () => {
    const { host, seen } = await start(() => ({ status: 200, json: {} }));
    const adapter = new ShellyCloudGateCommandAdapter(config(host), new FakeClock());

    const result = await adapter.pulse();

    expect(result.outcome).toBe('success');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.body).toEqual({
      id: 'testdevice', channel: 0, on: true, toggle_after: 1,
    });
    expect(seen[0]?.url).toContain('/v2/devices/api/set/switch');
    expect(seen[0]?.url).toContain('auth_key=test-key-not-real');
  });

  it('treats HTTP 200 alone as success, ignoring the body', async () => {
    const { host } = await start(() => ({ status: 200, json: { anything: 'at all' } }));
    const adapter = new ShellyCloudGateCommandAdapter(config(host), new FakeClock());
    expect((await adapter.pulse()).outcome).toBe('success');
  });

  it('maps DEVICE_OFFLINE', async () => {
    const { host } = await start(() => ({
      status: 400, json: { error: 'DEVICE_OFFLINE', data: { messages: ['offline'] } },
    }));
    const adapter = new ShellyCloudGateCommandAdapter(config(host), new FakeClock());
    expect((await adapter.pulse()).outcome).toBe('device-offline');
  });

  it('maps DEVICE_NOT_FOUND', async () => {
    const { host } = await start(() => ({
      status: 404, json: { error: 'DEVICE_NOT_FOUND', data: { messages: [] } },
    }));
    const adapter = new ShellyCloudGateCommandAdapter(config(host), new FakeClock());
    expect((await adapter.pulse()).outcome).toBe('device-not-found');
  });

  it('maps BAD_REQUEST', async () => {
    const { host } = await start(() => ({
      status: 400, json: { error: 'BAD_REQUEST', data: { messages: [] } },
    }));
    const adapter = new ShellyCloudGateCommandAdapter(config(host), new FakeClock());
    expect((await adapter.pulse()).outcome).toBe('bad-request');
  });

  it('maps DEVICE_FAILED_COMMAND', async () => {
    const { host } = await start(() => ({
      status: 400, json: { error: 'DEVICE_FAILED_COMMAND', data: { messages: [] } },
    }));
    const adapter = new ShellyCloudGateCommandAdapter(config(host), new FakeClock());
    expect((await adapter.pulse()).outcome).toBe('device-failed');
  });

  it('returns timeout WITHOUT retrying', async () => {
    let requests = 0;
    server = createServer((_req, _res) => { requests += 1; /* never respond */ })
      .listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const addr = server.address();
    if (typeof addr === 'string' || addr === null) throw new Error('no address');

    const adapter = new ShellyCloudGateCommandAdapter(
      { ...config(`127.0.0.1:${addr.port}`), timeoutMs: 150 }, new FakeClock(),
    );

    const result = await adapter.pulse();
    expect(result.outcome).toBe('timeout');
    expect(requests).toBe(1); // exactly one -- a retry could stop the gate
  });

  it('never puts the auth key in the returned detail', async () => {
    const { host } = await start(() => ({
      status: 400, json: { error: 'BAD_REQUEST', data: { messages: ['auth_key=test-key-not-real leaked'] } },
    }));
    const adapter = new ShellyCloudGateCommandAdapter(config(host), new FakeClock());
    const result = await adapter.pulse();
    expect(JSON.stringify(result)).not.toContain('test-key-not-real');
  });
});
```

- [ ] **Step 2: Run to verify failure** → FAIL, module not found.

- [ ] **Step 3: Implement the client and adapters**

`client.ts` owns three things: the 1 req/sec client-side rate limit (hold `lastRequestAt`; if the gap is under 1000ms, await the remainder), the `AbortSignal.timeout(timeoutMs)` on `fetch`, and secret redaction (a `redact()` that replaces the auth key with `***` in any string before it leaves the module). The `insecure` config flag exists only so tests can hit `http://127.0.0.1`; production builds the URL as `https://${host}`.

`gate-command-adapter.ts` maps the response:

```ts
const ERROR_TO_OUTCOME: Record<string, PulseOutcome> = {
  DEVICE_OFFLINE: 'device-offline',
  DEVICE_FAILED_COMMAND: 'device-failed',
  BAD_REQUEST: 'bad-request',
  DEVICE_NOT_FOUND: 'device-not-found',
};
```

Success is HTTP 200 and nothing else — do not parse the body for confirmation. On `AbortError` return `{ outcome: 'timeout' }`.

**Do not add a retry. Not here, not anywhere.** A timeout does not mean the command failed; it may have succeeded. A retry risks a second pulse that stops the gate mid-travel. The ambiguity is surfaced to the user instead.

`state-adapter.ts` POSTs `{ ids: [deviceId] }` to `/v2/devices/api/get` and returns `{ position: 'unknown', reachable: online === 1, checkedAt: clock.now() }`. **`position` is hardcoded `'unknown'`** — there is no sensor, and inferring it from command history would be a lie. A future reed-switch adapter replaces this class wholesale.

- [ ] **Step 4: Run tests** → all 8 PASS.

- [ ] **Step 5: Prove the no-retry invariant by mutation**

| Mutation | Must fail |
|---|---|
| Wrap the `fetch` in a 2-attempt retry loop on `AbortError` | `returns timeout WITHOUT retrying` (`requests` becomes 2) |
| Return `{ outcome: 'success' }` when the body parses but the status is 400 | `maps DEVICE_OFFLINE` |

Revert both. Record the observed failures in your report. The retry mutation is
the one that matters: a retry here can stop a moving gate.

- [ ] **Step 6: Commit**

```bash
git add backend/src/infrastructure/shelly
git commit -m "feat: shelly cloud adapters, no retry on timeout"
```

---

### Task 9: Auth infrastructure — argon2id, JWT, rate limiter, clock

**Files:**
- Create: `backend/src/infrastructure/password.ts`, `jwt.ts`, `clock.ts`, `rate-limiter.ts`
- Test: `backend/src/infrastructure/auth.test.ts`

**Interfaces:**
- Consumes: `TokenServicePort`, `ClockPort`, `RateLimiterPort`.
- Produces: `hashPassword(plain): Promise<string>`, `verifyPassword(hash, plain): Promise<boolean>`, `JwtTokenService`, `SystemClock`, `InMemoryRateLimiter`.

- [ ] **Step 1: Write the failing tests**

Cover: a hash verifies against its own password and fails against a wrong one; the hash string starts with `$argon2id$`; an access token round-trips `userId` and `role`; a token signed with a different secret fails verification; an expired token fails; the rate limiter allows exactly `limit` calls then denies; the limiter's window rolls over using the injected clock.

- [ ] **Step 2: Run to verify failure** → FAIL.

- [ ] **Step 3: Implement**

`password.ts` wraps the `argon2` package with `{ type: argon2.argon2id }`. No custom parameters — the library defaults are current and appropriate.

`jwt.ts` uses `jsonwebtoken` for access tokens with `expiresIn: '15m'`. Refresh tokens are **not** JWTs: generate 32 random bytes, store only a SHA-256 hash in `refresh_tokens`, and return the raw value once. `consumeRefreshToken` looks up by hash, checks `expires_at` and `revoked_at`, and rotates — marking the old one revoked and issuing a new one, so a stolen refresh token is single-use.

`rate-limiter.ts` is a `Map<string, { count: number; resetAt: number }>` using the injected clock.

```ts
// ponytail: in-memory, single-instance only. A second backend instance would
// have its own counters. Swap for Redis if this ever runs horizontally --
// the port makes it a composition-root change.
```

- [ ] **Step 4: Run tests** → PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/infrastructure/password.ts backend/src/infrastructure/jwt.ts backend/src/infrastructure/clock.ts backend/src/infrastructure/rate-limiter.ts backend/src/infrastructure/auth.test.ts
git commit -m "feat: argon2id hashing, rotating refresh tokens, rate limiter"
```

---

### Task 10: Remaining use cases

**Files:**
- Create: `backend/src/application/auth.ts`, `gate-status.ts`, `audit-events.ts`, `access-grants.ts`
- Test: `backend/src/application/auth.test.ts`, `access-grants.test.ts`

**Interfaces:**
- Consumes: ports from Task 2, fakes from Task 4.
- Produces: `AuthenticateUserUseCase`, `RefreshSessionUseCase`, `GetGateStatusUseCase`, `ListAuditEventsUseCase`, `IssueAccessGrantUseCase`, `RevokeAccessGrantUseCase`.

- [ ] **Step 1: Write the failing tests**

Critical cases: login with a wrong password and login with an unknown email return the **identical** error value (`{ ok: false, code: 'ACCESS_DENIED' }`) and take a comparable path — never leak whether the email exists; a disabled user cannot log in; a refresh token is single-use (second use fails); `IssueAccessGrantUseCase` rejects a non-owner issuer with `ACCESS_DENIED`; `RevokeAccessGrantUseCase` rejects a non-owner; a revoked grant immediately denies via the policy from Task 3.

- [ ] **Step 2: Run to verify failure** → FAIL.

- [ ] **Step 3: Implement**

In `AuthenticateUserUseCase`, when the email is unknown, still run a password verification against a dummy hash before returning, so the response time does not distinguish the two cases.

- [ ] **Step 4: Run tests** → PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/application
git commit -m "feat: auth, status, audit, and grant use cases"
```

---

### Task 11: Config, composition root, API routes, and the create-user CLI

**Files:**
- Create: `backend/src/config.ts`, `composition-root.ts`, `server.ts`
- Create: `backend/src/api/routes/{auth,gate,audit,grants}.ts`, `backend/src/api/errors.ts`
- Create: `backend/scripts/create-user.ts`
- Test: `backend/src/config.test.ts`, `backend/src/api/api.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `loadConfig(env): Config`, `buildApp(config): FastifyInstance`, `npm run create-user`.

- [ ] **Step 1: Write the failing config tests**

```ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const base = {
  SHELLY_HOST: 'h', SHELLY_AUTH_KEY: 'k', SHELLY_DEVICE_ID: 'd',
  JWT_SECRET: 'x'.repeat(32), GATE_COOLDOWN_MS: '5000',
  DATABASE_PATH: ':memory:', NODE_ENV: 'development',
  PUBLIC_URL: 'http://localhost:3000',
};

describe('loadConfig', () => {
  it('refuses to start when a secret is missing', () => {
    const { SHELLY_AUTH_KEY: _omitted, ...withoutKey } = base;
    expect(() => loadConfig(withoutKey)).toThrow(/SHELLY_AUTH_KEY/);
  });

  it('refuses to start in production without https', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' }))
      .toThrow(/https/i);
  });

  it('accepts production behind an https public url', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', PUBLIC_URL: 'https://gate.example.com' }))
      .not.toThrow();
  });

  it('rejects a short jwt secret', () => {
    expect(() => loadConfig({ ...base, JWT_SECRET: 'tooshort' })).toThrow(/JWT_SECRET/);
  });

  it('reads the cooldown from the environment', () => {
    expect(loadConfig({ ...base, GATE_COOLDOWN_MS: '7000' }).gateCooldownMs).toBe(7000);
  });

  it('never includes the auth key in a thrown message', () => {
    try {
      loadConfig({ ...base, NODE_ENV: 'production' });
    } catch (e) {
      expect(String(e)).not.toContain('k');
    }
  });
});
```

- [ ] **Step 2: Write the failing API tests**

Use `app.inject()` — Fastify's built-in injector, no HTTP server and no supertest dependency. Cover: `POST /gate/trigger` without a token returns 401; with a valid token returns 200; a second immediate trigger returns 409 with `retryAfterMs` in the body; `GET /gate/status` returns `position: 'unknown'`; a 500 response body never contains the auth key.

- [ ] **Step 3: Run to verify failure** → FAIL.

- [ ] **Step 4: Implement config with boot-time refusal**

Parse `env` with a Zod schema. Throw a plain `Error` naming the missing variable — never its value. In production, require `PUBLIC_URL` to start with `https://`; TLS is terminated by a reverse proxy and the Node process never handles certificates. Fail before `listen()`, not at 2am.

- [ ] **Step 5: Implement the composition root**

One file, wiring by hand, no DI container:

```ts
export function buildContainer(config: Config) {
  const clock = new SystemClock();
  const db = openDatabase(config.databasePath);

  // The one line to change for local network control. Swap this for
  // LocalRpcGateCommandAdapter or MqttGateCommandAdapter -- nothing else moves.
  const gateCommand: GateCommandPort = new ShellyCloudGateCommandAdapter(config.shelly, clock);
  const gateState: GateStatePort = new UnknownPositionStateAdapter(config.shelly, clock);

  const audit = new SqliteAuditLog(db);
  const trigger: TriggerGate = new AuditedTriggerGate(
    new TriggerGateUseCase(
      new SqliteUserRepository(db), new SqliteAccessGrantRepository(db),
      new RoleBasedAccessPolicy(), new SqliteCommandGuard(db, clock),
      gateCommand, clock, config.gateCooldownMs,
    ),
    audit, clock,
  );
  return { trigger, gateState, audit, clock, db };
}
```

- [ ] **Step 6: Implement the routes**

Thin: parse with the `/shared` Zod schema, call the use case, map the result. `backend/src/api/errors.ts` holds the single `ErrorCode → HTTP status` map:

```ts
const STATUS: Record<ErrorCode, number> = {
  GATE_COOLING_DOWN: 409, ATTEMPT_IN_PROGRESS: 409, DEVICE_OFFLINE: 502,
  TIMEOUT_AMBIGUOUS: 504, ACCESS_DENIED: 403, SESSION_EXPIRED: 401,
  RATE_LIMITED: 429, DEVICE_FAILED_COMMAND: 502, BAD_REQUEST: 400,
  DEVICE_NOT_FOUND: 502, USER_UNKNOWN: 403, USER_DISABLED: 403, INTERNAL: 500,
};
```

`USER_UNKNOWN` maps to 403 with the same body as `ACCESS_DENIED` — the client must not learn which. Configure the Fastify logger with a redaction serializer so `authKey`, `password`, and `token` never reach the output.

- [ ] **Step 7: Give `@gate/shared` a build step**

Deferred here from Task 1 deliberately. Until now every consumer of
`@gate/shared` has been `tsc` or Vitest, both of which resolve raw `.ts`
source. `server.ts` is the first thing that runs under plain `node`, which
cannot. Add to `shared/package.json`:

```json
"main": "./dist/api.js",
"types": "./dist/api.d.ts",
"exports": { ".": { "types": "./dist/api.d.ts", "default": "./dist/api.js" } },
"scripts": { "build": "tsc", "prepare": "tsc" }
```

Set `outDir: "./dist"` in `shared/tsconfig.json` and add a root
`"build": "npm run build --workspaces --if-present"`. Run the full suite
afterwards — if any import breaks, it breaks here where it is cheap, not in
production.

- [ ] **Step 8: Implement the create-user CLI**

`backend/scripts/create-user.ts` parses `--email`, `--password`, `--role` with `node:util`'s `parseArgs` — no CLI framework. It opens the database, hashes with the same argon2id helper, inserts, and prints the new id. This is the only way an account is created; there is no signup route.

- [ ] **Step 9: Run the full suite**

Run: `npm test` at the root. Every test from Tasks 1–11 must pass.

- [ ] **Step 10: Commit**

```bash
git add backend/src/config.ts backend/src/composition-root.ts backend/src/server.ts backend/src/api backend/scripts
git commit -m "feat: config, composition root, routes, create-user cli"
```

---

### Task 12: Expo vertical slice — login and trigger

The point of this task is to meet the Expo↔backend problems now, in isolation, rather than at the end alongside a full UI. Expect three: the device cannot resolve `localhost`, Android blocks cleartext HTTP by default, and the backend needs CORS for the dev client.

**Files:**
- Create: `app/` via `create-expo-app`, then `app/src/api.ts`, `app/src/session.ts`, `app/App.tsx`
- Modify: `backend/src/server.ts` (CORS for dev origins only)

**Interfaces:**
- Consumes: `@gate/shared` schemas; the running backend.
- Produces: `login(email, password)`, `trigger()`, `getStatus()` in `app/src/api.ts`; token storage in `app/src/session.ts`.

- [ ] **Step 1: Scaffold the app**

```bash
npx create-expo-app@latest app --template blank-typescript
npm i -w app expo-secure-store expo-haptics
```

Add `app` to the root `workspaces` array. Set `"strict": true` in `app/tsconfig.json`.

- [ ] **Step 2: Implement the API client**

`app/src/api.ts` reads the base URL from `expo-constants` (`extra.apiUrl`), set in `app.json` to the dev machine's **LAN IP**, not `localhost` — a phone cannot resolve the host machine's loopback. Parse every response with the `/shared` schema. Generate the idempotency key with `crypto.randomUUID()` per user-initiated tap, and **reuse the same key across retries of that tap**.

- [ ] **Step 3: Implement session storage**

`app/src/session.ts` uses `expo-secure-store` — `setItemAsync` / `getItemAsync` — for both tokens. **Never `AsyncStorage`**; it is unencrypted. On a 401, attempt one refresh, then fall through to a re-login prompt.

- [ ] **Step 4: Build the throwaway slice screen**

Email field, password field, a login button, and one trigger button that shows the raw result as text. **No styling work in this task** — the real UI is milestone 6 and its visual direction is §11.1 of the spec. This screen exists only to prove the wire.

- [ ] **Step 5: Enable CORS for development only**

In `server.ts`, register `@fastify/cors` only when `NODE_ENV !== 'production'`. In production the app is a native binary and sends no `Origin`, so CORS must not be enabled there.

- [ ] **Step 6: Verify end to end against a stubbed Shelly**

Point `SHELLY_HOST` at a local stub server (reuse the Task 8 harness, run standalone) so **no real gate moves**. Then:

1. `npm run create-user -- --email you@example.com --password 'a-real-one' --role owner`
2. Start the backend.
3. `npm start -w app`, open on a physical phone over the same Wi-Fi.
4. Log in. Confirm tokens land in secure store.
5. Tap trigger once → success.
6. Tap trigger again immediately → `GATE_COOLING_DOWN` with a `retryAfterMs` the client can read.

- [ ] **Step 7: Commit**

```bash
git add app backend/src/server.ts package.json
git commit -m "feat: expo vertical slice proving login and trigger end to end"
```

---

## Self-Review Notes

Checked against the spec:

- §3 ten ports — Task 2. §3.1 `CommandGuardPort` — Tasks 2 and 7.
- §4 trigger rule — Task 4. §4 auditing-as-wrapper — Task 5.
- §4.1 claim before call — Task 7, with the `IMMEDIATE` transaction.
- §4.2 pessimistic 2x, narrowed on confirmation — Task 7, plus the deliberate
  inversion check in Task 7 Step 5.
- §5 no-grant-means-deny — Task 3, including the revoked case.
- §6 schema and indexes, growth note — Task 6.
- §7 API surface, no signup route — Task 11.
- §8 Shelly contract, `toggle_after: 1`, no retry — Task 8.
- §9 error codes — Tasks 1 and 11.
- §10 security, boot checks — Tasks 9 and 11.
- §11 app — Task 12 (slice only; full UI is the next plan).
- §12 every required test case is present, each in a named task.

Deferred to a second plan, deliberately: §11.1 visual direction, the full UI,
biometric lock, activity list, icon and splash (milestone 6), and `README.md` /
`ARCHITECTURE.md` (milestone 7). Those depend on the slice in Task 12 actually
working, and planning them before that is planning on assumptions.
