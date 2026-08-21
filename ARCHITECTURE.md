# Architecture

One page on how Porta is put together and why. For setup and operation, see
[README.md](./README.md).

The shape follows from one hardware fact: **there is one command, a pulse, and
a second pulse while the gate is moving stops it mid-travel.** Almost every
decision below exists to make a second pulse hard to send by accident.

---

## Layers

```
┌─────────────────────────────────────────────────────────────┐
│  api/            Fastify routes. Parse, call a use case,    │
│                  map the result. No logic.                  │
├─────────────────────────────────────────────────────────────┤
│  application/    Use cases. Depend only on domain ports.    │
├─────────────────────────────────────────────────────────────┤
│  domain/         Entities, ten ports, typed errors, the     │
│                  access policy. Zero outward imports.       │
├─────────────────────────────────────────────────────────────┤
│  infrastructure/ Adapters implementing the ports:           │
│                  Shelly, SQLite, JWT, argon2, clock, limiter│
└─────────────────────────────────────────────────────────────┘

composition-root.ts   The only file that names a concrete adapter.
```

**Dependencies point inward only.** `domain/` imports nothing from
`application/`, `infrastructure/` or `api/` — enforced by a test that walks the
directory and fails on any outward import, at any depth, in either quote style,
including dynamic `import()`.

`domain/` is pure and unit-testable with zero I/O. Time is never read there or
in `application/`; it arrives through `ClockPort`, which is what makes
time-based access windows testable without waiting.

---

## The ten ports and their adapters

| Port | Real adapter | Test double |
|---|---|---|
| `GateCommandPort` | `ShellyCloudGateCommandAdapter` | `FakeGateCommand` |
| `GateStatePort` | `UnknownPositionStateAdapter` | `FakeGateState` |
| `AccessPolicyPort` | `RoleBasedAccessPolicy` *(pure, lives in `domain/`)* | — |
| `CommandGuardPort` | `SqliteCommandGuard` | `FakeGuard` |
| `AuditLogPort` | `SqliteAuditLog` | `FakeAuditLog` |
| `UserRepositoryPort` | `SqliteUserRepository` | `FakeUserRepo` |
| `AccessGrantRepositoryPort` | `SqliteAccessGrantRepository` | `FakeGrantRepo` |
| `TokenServicePort` | `JwtTokenService` | `FakeTokenService` |
| `ClockPort` | `SystemClock` | `FakeClock` |
| `RateLimiterPort` | `InMemoryRateLimiter` | *(used directly)* |

Notes on the ones that are not obvious:

- **`CommandGuardPort`** is a tenth port beyond the nine SPEC.md lists. Cooldown
  and idempotency are hot-path concurrency control, and routing them through
  `AuditLogPort` would mean that pruning audit rows silently disables the
  cooldown. A **shared contract test** binds `SqliteCommandGuard` and `FakeGuard`
  to the same assertions, so the two cannot drift — they did once, and a
  double-release halved the safety window.
- **`AccessPolicyPort.canOperate` takes grants as an argument** rather than
  fetching them. A policy that fetched would make the domain async and give it a
  database dependency; purity is the requirement with teeth.
- **`UnknownPositionStateAdapter`** always reports `position: 'unknown'`. There
  is no sensor. It reports only device reachability, and a future reed-switch
  adapter replaces it without the port changing.
- **`AuditLogPort` is append-only** and is never queried for safety decisions.

---

## Use cases

| Use case | Notes |
|---|---|
| `TriggerGateUseCase` | The core one. See the trigger path below |
| `AuditedTriggerGate` | Decorator, not a step inside the use case |
| `AuthenticateUserUseCase` | One answer, one branch, always hashes |
| `RefreshSessionUseCase` | Consumes then reissues; revokes on a disabled account |
| `GetGateStatusUseCase` | Degrades to `reachable: false` rather than throwing |
| `ListAuditEventsUseCase` | Rebuilds each row field by field |
| `IssueAccessGrantUseCase` | Owner-only; rejects an empty window |
| `RevokeAccessGrantUseCase` | Owner-only; idempotent |

**Auditing wraps the use case** rather than sitting at the end of it, because
`TriggerGateUseCase` returns *early* for an unknown user and for a denied policy
check — the attempts SPEC.md calls most important. An audit write placed as the
last statement would never run for them. Wrapping records every path by
construction rather than by remembering to log on each branch.

**`ListAuditEvents` rebuilds each row field by field**, never spreading, so
`detail` — a redacted stack trace — cannot reach a client even if `AuditEntry`
grows a field later.

---

## The trigger path

```
POST /gate/trigger
  → authGuard verifies the access token
  → rate limit: per user and per IP
  → AuditedTriggerGate
       → TriggerGateUseCase
            1. resolve user            → USER_UNKNOWN / USER_DISABLED
            2. AccessPolicyPort        → ACCESS_DENIED
            3. CommandGuardPort.tryClaim   ← BEFORE the call, not after
                 cooling-down          → GATE_COOLING_DOWN + retryAfterMs
                 replayed              → the original result, no pulse
            4. GateCommandPort.pulse()     ← exactly once, never retried
            5. CommandGuardPort.release(outcome)
       → audit row written on every path, including the early returns
  → response rebuilt field by field, internalDetail dropped
```

Four rules hold this together:

**Claim before calling.** If the pulse were recorded only after Shelly answers,
the cooldown would be blind for the entire duration of an in-flight request —
exactly the window it exists to protect.

**The window is pessimistic, then narrowed.** The claim is written at **2×** the
cooldown and narrowed to 1× only when the outcome is *confirmed*. An attempt
whose fate is unknown — a timeout, or a process that died mid-request —
therefore holds the **longer** guard. Writing 1× up front and extending on
timeout would invert this, giving the case with *less* information a weaker
guard.

**The claim is atomic.** `SqliteCommandGuard` uses
`db.transaction().immediate()`, so two concurrent taps cannot both win a claim.
`release` is once-only; a double release would halve the window.

**Nothing retries. Anywhere.** A timeout does not mean the command failed — it
may well have succeeded. Retrying risks a second pulse into a moving gate, so
the ambiguity is surfaced to the user instead. Do not add a retry to the
adapter, the client, or the use case.

---

## Swapping Shelly Cloud for local network control

The design goal is that this is a **one-line change**. In
`composition-root.ts`:

```ts
// The one line to change for local network control.
const gateCommand: GateCommandPort = new ShellyCloudGateCommandAdapter(config.shelly);
```

Replace it with a `LocalRpcGateCommandAdapter` or `MqttGateCommandAdapter`
implementing `pulse(): Promise<PulseResult>`. Nothing else moves: the use case,
the guard, the audit log and the API all speak to the port.

Three things the replacement must preserve, because the safety argument depends
on them rather than on the transport:

1. **Never retry**, on timeout or otherwise.
2. Map failures onto the existing `PulseOutcome` values. Anything other than
   `'timeout'` is treated as a *confirmed* outcome and narrows the cooldown.
3. Return diagnostic text on `PulseResult.detail`, already redacted. It reaches
   the audit log and nothing else.

`GateStatePort` would be swapped alongside it — and a reed switch, if one is
ever fitted, replaces `UnknownPositionStateAdapter` with something that returns
a real `position` without the port changing.

Note that the backend talks to **Shelly Cloud**, not to the relay on the LAN,
so today it can run anywhere. A local adapter would require it to run on the
gate's own network.

---

## Known limits

**The rate limiter is in-memory and single-instance.** `InMemoryRateLimiter`
holds its counters in a `Map` in one process. Run a second backend instance and
each gets its own counters, so the effective limit doubles. Horizontal scaling
would need a shared store — Redis with `INCR` and a TTL is the usual answer —
and because it sits behind `RateLimiterPort`, that is a composition-root change
and nothing more. The map is swept above a threshold of live keys, since keys
include client IPs an attacker chooses.

**The Shelly rate limit is process-wide.** One module-level timestamp enforces
Shelly's 1 request/second across every adapter. It is per-process for the same
reason as above.

**Reachability lags.** Shelly Cloud only marks a device offline once its
keepalive expires — up to about a minute — so `reachable` can describe a device
that is already dead. Every status response carries `checkedAt` for that reason,
and the app renders a failed *check* differently from a confirmed *offline*.

**Reachability parsing is a search, not a path.** `findOnline` walks the
response looking for `online` at any depth, because the exact shape could not be
verified without a live call. Confirmed working in both directions against real
hardware; run `npm run probe-shelly -w backend` to capture the real shape and
replace it with a direct lookup.

**`FakeTokenService` has no shared contract test**, unlike `CommandGuardPort`.
Tolerated because single-use is proven directly against `JwtTokenService` and no
use-case logic depends on the fake's replay behaviour. Write the contract test
if `TokenServicePort` gains a method or a second implementation appears.

---

## The app

One screen, no navigation library. `gate-machine.ts` holds every decision —
UI state, cooldown maths, error copy, clock formatting — with **no React and no
`react-native` imports**, so it is unit tested like the backend. Components
render what it returns.

That constraint is load-bearing: importing `./api` from it would reach
`expo-constants` and then `react-native`, whose Flow syntax no test runner here
can parse. The failure shape therefore lives in the machine and `api.ts` imports
it, not the other way round.

Tokens live in `expo-secure-store` (iOS keychain / Android keystore), never
`AsyncStorage`. The API client reads them back on every authenticated call, so
nothing is cached in memory.

The cooldown countdown always renders the **server's** `retryAfterMs` and never
a hardcoded value. A doubled window after an unconfirmed attempt must be visible
as a longer wait; a client assuming 5s would re-enable the button while the
server was still rejecting.

---

## Testing

Vitest across all three workspaces. **No test calls the real Shelly API** —
every one would move a real gate. `npm run stub-shelly -w backend` serves a
stand-in over HTTPS for end-to-end work.

Every safety-critical invariant is proven by **mutation**: the implementation is
deliberately broken, the test is watched failing, then reverted. A test that has
never failed has told you nothing. It has repeatedly earned its keep — it caught
a `Date` round-trip passing by accident, a window test with a six-hour gap that
made an off-by-one undetectable, and a boundary test that caught none of the
three import shapes it claimed to.
