# Build prompt: smart gate opener

Copy everything below the line into your coding agent. Fill in the four
`<PLACEHOLDER>` values first — they're marked in the Configuration section.

---

## Role

You are building a small production system: a mobile app plus a thin backend that
opens and closes a physical driveway gate. Treat it as safety-relevant software.
A bug here moves a heavy metal gate in the real world, so favour explicit,
conservative behaviour over cleverness, and never invent state you don't have.

## Hardware context (you cannot change any of this)

- The gate is driven by a **Roger Technology R70/2AC** control board, a 230 Vac
  swing-gate controller for two motors. It handles all motion logic, safety
  inputs, and auto-close itself. Your software does not control motors.
- A **Shelly 1 Gen4** relay is wired inside the R70 enclosure. Its potential-free
  contact (terminals I and O) bridges the R70's **PP (step-by-step)** input,
  terminals 30 and 33.
- Closing that contact momentarily is exactly equivalent to pressing the button
  on the physical remote. The R70's PP sequence is **open → stop → close → stop**.
- Consequences you must design around:
  - There is **one command**, a pulse. There is no "open" command and no "close"
    command. The gate's response depends on its current state.
  - A second pulse while the gate is moving **stops it mid-travel**. This is the
    main failure mode to protect against.
  - After any power cut, the first PP command is always *open*, regardless of
    where the gate physically is.
- There is currently **no position sensor**. The system genuinely does not know
  whether the gate is open or closed. A reed switch may be added later.
- The physical remote continues to work and is unaffected. Anyone may operate the
  gate from outside your system at any time, so cached state is never
  authoritative.

## What to build

Two deliverables in one repository:

1. **`/backend`** — a small HTTP service. Holds the Shelly credential, owns all
   authorisation and audit logging. The only component that ever talks to Shelly.
2. **`/app`** — a cross-platform mobile app. Talks only to your backend. Contains
   no Shelly credentials of any kind.

```
app  →  backend  →  Shelly Cloud  →  Shelly 1 Gen4  →  R70/2AC  →  gate
```

## Stack

- **App**: React Native with Expo, TypeScript, strict mode. (If you have a strong
  reason to prefer Flutter, say so before starting rather than switching midway.)
- **Backend**: Node 20+, TypeScript strict, Fastify. SQLite via better-sqlite3
  behind a repository interface — the storage engine must be swappable.
- **Shared**: a `/shared` package of TypeScript types and Zod schemas for the API
  contract, consumed by both sides. One source of truth for request and response
  shapes.
- Do not add a framework whose main contribution is a DI container. Wire
  dependencies by hand in a single composition root.

## Architecture requirements

The user has explicitly asked for SOLID. Apply it where it earns its place, not
as ceremony. Concretely:

### Layering

```
domain/          entities, value objects, port interfaces. Zero imports from
                 outside this folder. No HTTP, no SQL, no SDKs.
application/     use cases. Depend only on domain ports.
infrastructure/  adapters implementing domain ports (Shelly, SQLite, JWT, clock).
api/             Fastify routes. Thin — parse, call use case, map to response.
```

Dependencies point inward only. `domain` must be unit-testable with no I/O.

### Ports to define in the domain layer

- `GateCommandPort` — `pulse(): Promise<PulseResult>`. The critical abstraction.
  Ship `ShellyCloudGateCommandAdapter`. The design goal is that swapping to a
  `LocalRpcGateCommandAdapter` or `MqttGateCommandAdapter` later is a one-line
  change in the composition root and nothing else.
- `GateStatePort` — `getState(): Promise<GateState>` where
  `GateState = { position: 'open' | 'closed' | 'unknown', reachable: boolean, checkedAt: Date }`.
  Ship `UnknownPositionStateAdapter`, which reports device reachability from the
  Shelly API but always returns `position: 'unknown'`. Structure it so a future
  reed-switch adapter drops in cleanly.
- `AccessPolicyPort` — `canOperate(user, at: Date): PolicyDecision`. Ship
  `RoleBasedAccessPolicy`. This is the seam for temporary guest access later.
- `AuditLogPort`, `UserRepositoryPort`, `AccessGrantRepositoryPort`,
  `TokenServicePort`, `ClockPort`, `RateLimiterPort`.

Inject `ClockPort` everywhere time is read. Never call `Date.now()` inside a use
case — time-based access windows must be testable without waiting.

### Use cases

- `TriggerGateUseCase` — the core one. See rules below.
- `GetGateStatusUseCase`
- `AuthenticateUserUseCase`, `RefreshSessionUseCase`
- `ListAuditEventsUseCase`
- `IssueAccessGrantUseCase`, `RevokeAccessGrantUseCase` — implement the domain
  model and persistence now, expose behind an owner-only endpoint. The mobile UI
  for guest access is out of scope for this build.

## The trigger rule (get this exactly right)

`TriggerGateUseCase.execute(userId, idempotencyKey)`:

1. Resolve the user. Reject if unknown or disabled.
2. Ask `AccessPolicyPort`. Reject with a reason if denied.
3. **Idempotency**: if this `idempotencyKey` was seen in the last 60 seconds,
   return the original result without sending a second pulse. The app generates a
   fresh UUID per user-initiated tap and retries with the same one.
4. **Cooldown**: reject if any pulse was sent within the last **5 seconds**, with
   a distinct `GATE_COOLING_DOWN` error carrying `retryAfterMs`. This exists
   specifically to stop double-taps from halting the gate mid-travel. Make the
   window a named constant with a comment explaining why.
5. Call `GateCommandPort.pulse()`.
6. Write an audit entry — user, timestamp, outcome, error code if any — on both
   success and failure. Failed and denied attempts matter more than successful ones.
7. Return a typed result. Never throw raw adapter errors across the layer boundary.

## Shelly Cloud adapter contract

Send a single pulse — the relay closes and releases itself, so no second call:

```
POST https://<SHELLY_HOST>/v2/devices/api/set/switch?auth_key=<SHELLY_AUTH_KEY>
Content-Type: application/json

{ "id": "<SHELLY_DEVICE_ID>", "channel": 0, "on": true, "toggle_after": 1 }
```

Read device reachability with:

```
POST https://<SHELLY_HOST>/v2/devices/api/get?auth_key=<SHELLY_AUTH_KEY>
Content-Type: application/json

{ "ids": ["<SHELLY_DEVICE_ID>"] }
```

The response includes an `online` field (`0` or `1`).

Notes that will bite you if ignored:

- Success is signalled **only by HTTP 200**. Do not parse a body for confirmation.
- Errors return `{ "error": "<STRING>", "data": { "messages": string[] } }`.
  Map `DEVICE_OFFLINE` to a first-class domain error — it's the one users will
  actually hit, when Wi-Fi at the gate pillar drops. Also handle
  `DEVICE_FAILED_COMMAND`, `BAD_REQUEST`, `DEVICE_NOT_FOUND`.
- The Shelly API is rate-limited to **1 request per second**. Enforce this
  client-side in the adapter.
- Set an aggressive HTTP timeout (5s). A hanging request must not leave the app
  spinning indefinitely.
- **Do not retry a pulse automatically on timeout.** A timeout does not mean the
  command failed — it may have succeeded. Surface the ambiguity to the user
  instead of risking a second pulse that stops the gate. This is deliberate;
  document it in a comment.

## Security requirements

These are hard requirements, not suggestions.

- `SHELLY_AUTH_KEY` lives **only** in a backend environment variable. It must
  never appear in the mobile app, in the repository, in logs, or in an error
  response. The Shelly auth key is account-wide and does not expire — anyone
  holding it controls every device on the account.
- Commit a `.env.example` with placeholder values. Add `.env` to `.gitignore`.
- Passwords hashed with argon2id. No plaintext, no fast hashes.
- JWT access tokens with short expiry (15 min) plus refresh tokens. Store both in
  the OS keystore on the app side (`expo-secure-store`), never `AsyncStorage`.
- Rate limit per user and per IP on the trigger and auth endpoints.
- The backend must refuse to start if it is not serving over HTTPS in production,
  or if any required secret is missing. Fail loudly at boot, not at 2am.
- Redact secrets from all log output.
- Never leak whether an email exists during login failures.

## Mobile app requirements

Keep it deliberately small. One screen does the job.

- **A single large primary button** reading "Open / close gate". Not two buttons —
  the hardware only offers one command, and pretending otherwise misleads the user.
- Explicit visual states: idle → sending → success → error, with haptic feedback
  on tap and on result.
- **Show honest state.** With no position sensor, display "Position unknown" and
  the device's online/offline status. Never guess or infer position from command
  history. A gate app that confidently displays "Closed" when it doesn't know is
  worse than one that admits ignorance.
- Disable the button for the cooldown period after a tap, with a visible
  countdown. This is the primary defence against the stop-mid-travel failure mode.
- Handle these distinctly, with plain-language messages: no network, backend
  unreachable, session expired, access denied, gate offline, cooling down.
- Optional biometric lock on app open, defaulting to on.
- A simple recent-activity list from the audit log — who operated the gate and when.
- Ship a sensible icon and splash screen. This is going on a phone home screen.

## Testing

- Unit tests for every use case using in-memory fakes of every port. No network,
  no filesystem, no real clock.
- Explicit test cases for: cooldown rejection, idempotent replay, access denied,
  `DEVICE_OFFLINE` propagation, and adapter timeout not triggering a retry.
- One integration test against a stubbed Shelly HTTP server asserting the exact
  request shape, including `toggle_after: 1`.
- Do not write tests that call the real Shelly API. Each one moves a real gate.

## Configuration

```
SHELLY_HOST=<SHELLY_HOST>
SHELLY_AUTH_KEY=<SHELLY_AUTH_KEY>
SHELLY_DEVICE_ID=<SHELLY_DEVICE_ID>
JWT_SECRET=<JWT_SECRET>
GATE_COOLDOWN_MS=5000
```

Real values live only in the gitignored `.env` — never in this file or in git history.

## Deliverables

1. Working monorepo with `/app`, `/backend`, `/shared`.
2. `README.md` covering local setup, how to obtain each Shelly value, how to
   deploy the backend behind TLS, and how to add the first user.
3. `ARCHITECTURE.md` — one page: the layer diagram, every port and its adapters,
   and a short section on how to swap Shelly Cloud for local network control.
4. Tests passing.

## Out of scope — do not build

- Any auto-close, timer, or scheduling logic. The R70 board handles auto-close via
  its own DIP switch and trimmer. Duplicating it in software risks two systems
  fighting over one gate.
- Camera, video, or intercom features.
- Guest-access UI (model and endpoints only, as specified above).
- Push notifications.
- Multi-gate support. Model one gate; don't build speculative abstraction for
  gates that don't exist.

## Before you start

State your plan and flag any assumption you're making. If a requirement here
conflicts with something you discover, raise it rather than silently resolving it.
