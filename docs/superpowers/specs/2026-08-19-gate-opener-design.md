# Smart Gate Opener — Design

Date: 2026-08-19
Source requirements: `SPEC.md`

## 1. Problem

A React Native app and a thin backend that pulse a Shelly 1 Gen4 relay, which
bridges the PP (step-by-step) input on a Roger Technology R70/2AC gate board.

Three hardware facts drive the entire design:

- **There is one command: a pulse.** No open, no close. The gate's response
  depends on state we cannot observe.
- **A second pulse mid-travel stops the gate.** This is the failure mode the
  software exists to prevent.
- **There is no position sensor.** The system does not know whether the gate is
  open or closed, and must never pretend otherwise.

The physical remote keeps working, so any state we cache is stale by
construction. Treat this as safety-relevant software: conservative and explicit
over clever.

## 2. Repository layout

npm workspaces — no additional monorepo tooling.

```
/shared      Zod schemas + inferred types. The API contract, one source of truth.
/backend     Node 20+, Fastify, TypeScript strict.
/app         Expo React Native, TypeScript strict.
```

### Backend layering

```
domain/          Entities, value objects, port interfaces, typed errors.
                 Zero outward imports. No HTTP, no SQL, no SDKs.
application/     Use cases. Depend only on domain ports.
infrastructure/  Adapters implementing domain ports.
api/             Fastify routes. Parse, call use case, map to response.
composition-root.ts   The only file that names a concrete adapter.
```

Dependencies point inward only. `domain` is unit-testable with no I/O.

## 3. Ports

Ten ports in the domain layer. The nine from `SPEC.md`, plus `CommandGuardPort`.

| Port | Shipped adapter | Purpose |
|---|---|---|
| `GateCommandPort` | `ShellyCloudGateCommandAdapter` | `pulse(): Promise<PulseResult>` |
| `GateStatePort` | `UnknownPositionStateAdapter` | Reachability only; position always `unknown` |
| `AccessPolicyPort` | `RoleBasedAccessPolicy` | `canOperate(user, at): PolicyDecision` |
| `CommandGuardPort` | `SqliteCommandGuard` | Atomic cooldown + idempotency claim |
| `AuditLogPort` | `SqliteAuditLog` | Append-only event record |
| `UserRepositoryPort` | `SqliteUserRepository` | |
| `AccessGrantRepositoryPort` | `SqliteAccessGrantRepository` | |
| `TokenServicePort` | `JwtTokenService` | |
| `ClockPort` | `SystemClock` | Injected everywhere time is read |
| `RateLimiterPort` | `InMemoryRateLimiter` | Per-user and per-IP |

`GateCommandPort` is the critical seam. Swapping `ShellyCloudGateCommandAdapter`
for a `LocalRpcGateCommandAdapter` or `MqttGateCommandAdapter` must be a one-line
change in the composition root and nothing else.

`ClockPort` is injected wherever time is read. `Date.now()` never appears inside
a use case — time-based access windows must be testable without waiting.

### 3.1 CommandGuardPort

Cooldown and idempotency are concurrency control on the hot path, not
observability. They get their own port.

```ts
type ClaimResult =
  | { kind: 'granted'; claimId: string }
  | { kind: 'cooling-down'; retryAfterMs: number }
  | { kind: 'replayed'; outcome: PulseOutcome | 'pending' };

interface CommandGuardPort {
  tryClaim(params: {
    idempotencyKey: string;
    cooldownMs: number;
    idempotencyWindowMs: number;
  }): Promise<ClaimResult>;

  release(claimId: string, outcome: PulseOutcome): Promise<void>;
}
```

`tryClaim` takes both windows because they differ in scope and duration:
idempotency looks back `idempotencyWindowMs` scoped to a single key; cooldown
looks back `cooldownMs` across *all* keys. One parameter cannot express both.

`cooldownMs` comes from `GATE_COOLDOWN_MS` in the environment.
`idempotencyWindowMs` is a named constant of 60s — `SPEC.md` fixes the value and
lists no environment variable for it — declared with a comment explaining what it
protects against, alongside the cooldown constant.

`replayed` carries `'pending'` when the original claim is still in flight — two
taps 300ms apart with the same key. Idempotency is evaluated before cooldown
(per the trigger rule ordering), so this state is reachable and must be handled
rather than assumed away.

Backed by SQLite in the same database file, but kept as a distinct interface.
This is the seam for a Redis-backed implementation if the backend ever runs on
more than one instance.

`AuditLogPort` stays append-only. Routing safety behaviour through the audit log
would mean pruning old rows silently disables the cooldown.

## 4. The trigger rule

`TriggerGateUseCase.execute(userId, idempotencyKey)`:

1. Resolve the user. Reject if unknown or disabled.
2. Ask `AccessPolicyPort.canOperate(user, clock.now())`. Reject with a reason if denied.
3. **Claim before calling.** `guard.tryClaim({ idempotencyKey, cooldownMs, idempotencyWindowMs })`.
   - `cooling-down` → return `GATE_COOLING_DOWN` with `retryAfterMs`.
   - `replayed` → return the original outcome without pulsing. `'pending'` maps
     to `ATTEMPT_IN_PROGRESS`.
   - `granted` → continue, holding `claimId`.
4. `GateCommandPort.pulse()`.
5. `guard.release(claimId, outcome)`.
6. Write an audit entry — user, timestamp, outcome, error code — on success,
   failure, and denial alike. Failed and denied attempts matter more than
   successful ones.
7. Return a typed result. Never throw raw adapter errors across the layer boundary.

### 4.1 Why the claim precedes the call

If the pulse timestamp were recorded only after Shelly responds, then for the
entire duration of that in-flight HTTP request the cooldown check would see
nothing. A second tap two seconds later would pass, send a second pulse, and stop
the gate mid-travel — precisely the failure the cooldown exists to prevent. The
cooldown would be inoperative during the window it exists to protect.

The claim must therefore be recorded *before* the Shelly call, and must be a
single atomic operation — a conditional `INSERT` inside an `IMMEDIATE`
transaction, never a read followed by a write. The same applies to the
idempotency key: it is recorded at claim time, or two rapid retries carrying the
same key both proceed.

### 4.2 The guard counts attempts, not successes

A claim holds the cooldown regardless of how the attempt resolves.

| Outcome | Cooldown held |
|---|---|
| `success` | `GATE_COOLDOWN_MS` |
| `timeout-ambiguous` | `GATE_COOLDOWN_MS * 2` |
| `device-offline` and other confirmed failures | `GATE_COOLDOWN_MS` |

**Timeout.** A timed-out request may well have delivered the pulse. The system
has *less* information than usual about what just happened, so it waits longer:
`GATE_COOLDOWN_MS * 2`. `release` extends the claim's `cooling_until` when the
outcome is a timeout.

**Confirmed failure.** A `DEVICE_OFFLINE` response means no pulse was delivered,
so in principle an immediate retry is harmless. The cooldown is held anyway: the
cost is five seconds, the cost of being wrong is a gate stopped mid-travel, and
holding it also stops a retry loop hammering an offline device.

**Abandoned claims.** If the process dies between `tryClaim` and `release`, the
claim keeps its outcome column null forever. `cooling_until` was written at claim
time, so the cooldown still expires on schedule and the gate is not bricked. The
only lasting effect is that a replay of that exact key within the idempotency
window reports `'pending'`. No reaper process; the rows age out of relevance on
their own.

## 5. Access policy

Two roles, plus grants.

```
owner  → always permitted (unless the account is disabled). No grant required.
user   → permitted only while holding an AccessGrant whose window covers `at`.
```

**Security decision: no grant means deny.** A `user` with no currently-valid
grant cannot operate the gate. This is the default branch in
`RoleBasedAccessPolicy`, not an incidental outcome. A freshly created `user`
account can do nothing until an owner issues a grant. A revoked grant denies
immediately — revocation must never fall back to permissive behaviour. Both
cases are covered by tests.

Guests are `user` accounts holding a time-bounded grant; there is no separate
guest account type. The grant model and its owner-only endpoints are built now;
the mobile UI for guest access is out of scope.

## 6. Data model

SQLite via better-sqlite3, behind repository interfaces so the engine is
swappable.

- `users` — id, email (unique), password_hash, role, disabled, created_at
- `access_grants` — id, user_id, starts_at, ends_at, created_by, revoked_at
- `audit_events` — id, user_id (nullable; unknown-user attempts are still
  logged), action, outcome, error_code, idempotency_key, created_at
- `refresh_tokens` — id, user_id, token_hash, expires_at, revoked_at
- `command_claims` — id, idempotency_key, claimed_at, cooling_until, outcome

`refresh_tokens` exists so logout and account-disable revoke a session
immediately rather than waiting out a stateless JWT.

Indexes in the initial migration: `audit_events(created_at)`,
`audit_events(idempotency_key)`, `command_claims(claimed_at)`,
`command_claims(idempotency_key)`.

## 7. API surface

| Method | Path | Notes |
|---|---|---|
| POST | `/auth/login` | Never leaks whether an email exists |
| POST | `/auth/refresh` | |
| POST | `/auth/logout` | Revokes the refresh token |
| POST | `/gate/trigger` | Rate limited per user and per IP |
| GET | `/gate/status` | Reachability; position always `unknown` |
| GET | `/audit` | Recent activity |
| POST | `/access-grants` | Owner only |
| DELETE | `/access-grants/:id` | Owner only |

No signup route. Accounts are created only by `backend/scripts/create-user.ts`,
which writes to SQLite using the same argon2id hashing — the smallest attack
surface for a door opener. `GET /access-grants` is omitted; `SPEC.md` asked for
issue and revoke only.

Request and response shapes come from `/shared` Zod schemas, consumed by both
sides.

## 8. Shelly adapter

```
POST https://<SHELLY_HOST>/v2/devices/api/set/switch?auth_key=<SHELLY_AUTH_KEY>
{ "id": "<SHELLY_DEVICE_ID>", "channel": 0, "on": true, "toggle_after": 1 }
```

The relay closes and releases itself, so one call is a complete pulse.
Reachability comes from `POST /v2/devices/api/get` with `{ "ids": [...] }`,
reading the `online` field.

- Success is signalled **only by HTTP 200**. No body parsing for confirmation.
- Errors return `{ "error": string, "data": { "messages": string[] } }`.
  `DEVICE_OFFLINE` maps to a first-class domain error — it is the one users will
  actually hit when Wi-Fi at the gate pillar drops. `DEVICE_FAILED_COMMAND`,
  `BAD_REQUEST`, and `DEVICE_NOT_FOUND` are also mapped.
- Client-side rate limit of 1 request/second, enforced in the adapter.
- 5s HTTP timeout.
- **No automatic retry on timeout**, ever. A timeout does not mean the command
  failed; it may have succeeded. Retrying risks a second pulse that stops the
  gate. The ambiguity is surfaced to the user as `TIMEOUT_AMBIGUOUS` instead.

## 9. Error handling

Use cases return a typed discriminated union; they never throw across a layer
boundary. The API layer maps result to HTTP status plus
`{ error: CODE, message, retryAfterMs? }`.

Codes: `GATE_COOLING_DOWN`, `ATTEMPT_IN_PROGRESS`, `DEVICE_OFFLINE`,
`TIMEOUT_AMBIGUOUS`, `ACCESS_DENIED`, `SESSION_EXPIRED`, `RATE_LIMITED`,
`DEVICE_FAILED_COMMAND`, `BAD_REQUEST`, `DEVICE_NOT_FOUND`.

## 10. Security

- `SHELLY_AUTH_KEY` lives only in a backend environment variable. Never in the
  app, the repository, logs, or an error response. The key is account-wide and
  does not expire — anyone holding it controls every device on the account.
- `.env` is gitignored; `.env.example` carries placeholders only.
- Passwords hashed with argon2id.
- JWT access tokens, 15 min expiry, plus refresh tokens. Both stored in the OS
  keystore via `expo-secure-store`, never `AsyncStorage`.
- Rate limiting per user and per IP on trigger and auth endpoints.
- Secrets redacted from all log output.
- Login failures never reveal whether an email exists.

### Boot-time checks

The backend refuses to start — before `listen()` — if any required secret is
missing, or if `NODE_ENV=production` and `PUBLIC_URL` does not begin with
`https://`. TLS is terminated by a reverse proxy (Caddy, nginx, Fly, Render);
the Node process never handles certificates. Fail loudly at boot, not at 2am.

`GATE_COOLDOWN_MS` is read from the environment. No hardcoded `5000` anywhere in
the codebase.

## 11. Mobile app

One screen.

- **A single large primary button**, "Open / close gate". Not two buttons — the
  hardware offers one command, and pretending otherwise misleads the user.
- Explicit states: idle → sending → success → error, with haptics on tap and on
  result.
- **Honest state.** "Position unknown", plus device online/offline. Position is
  never guessed or inferred from command history. A gate app that confidently
  displays "Closed" when it does not know is worse than one that admits
  ignorance.
- The button is disabled for the cooldown period after a tap, with a visible
  countdown. This is the primary defence against the stop-mid-travel failure
  mode.
- Distinct plain-language messages for: no network, backend unreachable, session
  expired, access denied, gate offline, cooling down, attempt in progress.
- Biometric lock on app open, defaulting to on.
- Recent-activity list from the audit log.
- Ship an icon and splash screen.

Visual direction is an open question — see §16. It must be settled before
milestone 6, not decided implicitly while building.

## 12. Testing

Vitest. No test calls the real Shelly API — each one would move a real gate.

Unit tests for every use case against in-memory fakes of every port. No network,
no filesystem, no real clock.

Required cases:

- Cooldown rejection.
- Idempotent replay.
- Access denied — including a `user` with no grant, and a `user` whose grant was
  revoked.
- `DEVICE_OFFLINE` propagation.
- Adapter timeout does not trigger a retry.
- **A timed-out pulse followed by an immediate second attempt is rejected with
  `GATE_COOLING_DOWN`.**

One integration test against a stubbed Shelly HTTP server asserting the exact
request shape, including `toggle_after: 1`.

## 13. Milestones

Each milestone ends with a fresh-context code review, fixes, and a full test run
before the next begins. `PROGRESS.md` is updated at each one.

1. **Scaffold** — workspaces, `/shared` Zod schemas, strict tsconfig, Vitest,
   `.env.example`.
2. **Domain layer** — entities, ten ports, typed errors, `RoleBasedAccessPolicy`.
   Pure and unit-tested.
3. **Application layer** — seven use cases, TDD against fakes.
4. **Infrastructure** — SQLite migrations and repositories, `SqliteCommandGuard`,
   Shelly adapters, JWT and argon2id, rate limiter, clock.
5. **API + vertical slice** — Fastify routes, composition root, `create-user`
   CLI, boot checks, and a thin end-to-end slice: login plus one trigger from a
   real Expo app against a stubbed Shelly. Expo-to-local-backend has its own
   problems — the device cannot resolve `localhost`, plus cleartext/ATS and CORS
   restrictions — and meeting them here rather than at the end is deliberate.
6. **Mobile app** — full UI, visual states, cooldown countdown, honest status,
   biometric lock, activity list, icon and splash.
7. **Docs and hardening** — `README.md` (setup, obtaining each Shelly value, TLS
   deployment, adding the first user), `ARCHITECTURE.md` (layer diagram, every
   port and adapter, how to swap Shelly Cloud for local control, and a note that
   the in-memory rate limiter is single-instance only and what horizontal
   scaling would require). Full suite, final review.

## 14. Out of scope

- Auto-close, timers, scheduling. The R70 board handles auto-close via its own
  DIP switch and trimmer; duplicating it risks two systems fighting over one
  gate.
- Camera, video, intercom.
- Guest-access UI (model and endpoints only).
- Push notifications.
- Multi-gate support. One gate, no speculative abstraction.

## 15. Assumptions

1. The Shelly relay is already configured with `toggle_after` behaviour
   compatible with a 1s pulse on the PP input.
2. `SHELLY_HOST` is the correct regional Shelly Cloud endpoint for this account.
3. The backend runs as a single instance. `InMemoryRateLimiter` and
   `SqliteCommandGuard` are correct under that assumption and are documented as
   the seams to replace if that changes.
4. The credentials originally pasted into `SPEC.md` are treated as compromised
   and should be rotated; they now live only in a gitignored `.env`.

## 16. Open questions

1. **Visual direction for the app.** `SPEC.md` specifies behaviour and states but
   no aesthetic. Needed before milestone 6. Default if unanswered: a dark,
   high-contrast utility screen — one oversized button, heavy type, no
   decoration. Optimised for glanceability in a car at night, which is the actual
   usage context.
2. **`ATTEMPT_IN_PROGRESS` as a distinct response**, versus folding the pending
   replay case into `GATE_COOLING_DOWN`. Design assumes distinct.
