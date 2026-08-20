# Progress

Resume point for a fresh session: read this file, then
`docs/superpowers/specs/2026-08-19-gate-opener-design.md` (the design) and
`docs/superpowers/plans/2026-08-19-gate-opener-backend.md` (the task list).
Those two plus `git log` are enough to know exactly where things stand.

Execution ledger with every ruling:
`.superpowers/sdd/2026-08-19-gate-opener-backend/progress.md` (git-ignored).

## Status: plan one complete (12 of 12), verified on a physical phone

Branch: `build/gate-opener-backend`

## Done

**Planning.** Design doc written and revised twice; implementation plan written
for milestones 1–5 as 12 TDD tasks. Three defects were caught during design
review before any code existed:

- The cooldown was blind during the in-flight Shelly request — the exact window
  it exists to protect. Fixed by claiming before calling.
- The claim-time window was inverted: an abandoned claim got a *weaker* guard
  than a timeout despite carrying strictly less information. Fixed by writing
  the pessimistic 2× window at claim time and narrowing only on evidence.
- Auditing sat at the end of a numbered list whose first two steps return early,
  so denied attempts would never have been logged. Moved to a decorator.

**Secrets.** `SPEC.md` arrived carrying a live Shelly auth key and JWT secret.
They were moved to a gitignored `.env` *before the repo's first commit*, so they
were never in git history and need no rotation. `SPEC.md` tracks placeholders.

**Task 1 — workspace scaffold and `/shared` contract.** npm workspaces, Zod
schemas, strict TS. Review clean.

**Task 2 — domain layer.** Ten ports, entities, typed errors, constants. The
layer-boundary test shipped weak (my plan's fault: flat-file, single-quoted,
one-level-relative imports only) and was rebuilt to recurse subdirectories and
catch any depth, both quote styles, dynamic `import()`, and aliased specifiers.

**Task 3 — `RoleBasedAccessPolicy`.** No-grant-means-deny as the default branch.
Mutation testing found the brief's window test had a six-hour gap that made an
off-by-one undetectable; tightened. A cross-user test was added proving one
user's grant cannot authorize another.

**Task 4 — `TriggerGateUseCase`**, the core safety logic. Three fix rounds.
`execute()` gained a `try/catch` so adapter rejections cannot cross the layer
boundary, carrying the error out on an `internalDetail` field deliberately kept
out of the shared wire schema. A shared `CommandGuardPort` contract test was
built here so the in-memory fake and the real SQLite guard cannot drift apart.

**Task 5 — `AuditedTriggerGate`.** Auditing wraps the use case rather than
sitting inside it, so early rejections are recorded by construction. Added a
credential redactor: `SHELLY_AUTH_KEY` travels as a URL query parameter, so a
failed fetch's stack can carry it verbatim into an audit row. Covers URL, JSON,
`Authorization: Bearer`, and prefixed-key shapes.

**Task 6 — SQLite schema and repositories.** Epoch-ms timestamps, nullable
`audit_events.user_id` so unknown-user attempts are still recorded, idempotent
migration, six required indexes.

**Task 7 — `SqliteCommandGuard`.** Atomic claim via `db.transaction().immediate()`.
Two fix rounds: `release` made once-only (a double release halved the safety
window), and the double-release rule moved into the shared contract so both
implementations are bound by it.

**Task 8 — Shelly Cloud adapters.** One `shellyPost` function owns the URL, the
5s `AbortSignal.timeout`, the 1 req/sec limit, and redaction; two thin adapters
map its reply. Tested against a real `node:http` stub server on port 0 — no
mocking library. The no-retry rule is the point of the task: a timeout does not
mean the pulse failed, and a second pulse stops a moving gate.

**Task 9 — auth infrastructure.** argon2id via the `argon2` package (defaults,
no hand-tuned cost parameters), `JwtTokenService`, `SystemClock`,
`InMemoryRateLimiter`. Refresh tokens are not JWTs: 32 random bytes, only the
SHA-256 stored, single-use because revoking *is* the lookup — one guarded
`UPDATE ... RETURNING`, so a replayed token cannot come back with a user twice.
Access tokens pin HS256 on verify; the first test of that pin was worthless
(jsonwebtoken already refuses `alg:none` for a string secret) and was replaced
with an HS512-signed-with-the-real-secret token, which only a pinned verifier
rejects.

**Task 10 — remaining use cases.** Login answers a wrong password, an unknown
email and a disabled account with one identical value from one branch, and
always runs a verification — an unknown email is checked against a real
argon2id hash of nothing, so response time is not an account-existence oracle.
Refresh consumes then reissues, and a disabled user's outstanding refresh
tokens are revoked, so disabling an account ends the sessions it already has.
Grants are owner-only and reject a window that cannot grant anything.
`ListAuditEvents` rebuilds each row field by field, so `detail` (a redacted
stack trace) cannot reach a client even if `AuditEntry` grows a field.

**Task 11 — config, composition root, API routes, `create-user` CLI.** The
process refuses to boot without every secret, or in production behind a plain
`http://` `PUBLIC_URL`; the thrown message names the variable and never prints
its value. Routes rebuild every response field by field rather than spreading
a use-case result — `TriggerResult` carries `internalDetail`, a raw adapter
error whose text can hold the auth key. `USER_UNKNOWN` and `USER_DISABLED`
reach the client as `ACCESS_DENIED`, same status and same body, so no endpoint
answers "does this account exist". `@gate/shared` gained a build step:
`server.ts` is the first thing to run under plain `node`, which cannot resolve
raw `.ts` out of `node_modules`.

Verified against the compiled output, not just the tests: `create-user` made
an account, the server booted, login returned a token pair, `/gate/status`
reported `reachable: false` in 39ms against an unresolvable host, the real
`SqliteCommandGuard` answered a second tap with 409, the 500 body carried no
`internalDetail`, and pino logged no bodies or headers at all.

**Task 12 — Expo vertical slice.** Expo SDK 57, three source files:
`App.tsx`, `src/api.ts`, `src/session.ts`. Tokens live in `expo-secure-store`,
never `AsyncStorage`. The base URL is derived from Metro's `hostUri` instead of
a hand-pasted LAN IP — the phone cannot resolve the dev machine's `localhost`,
and an IP written into `app.json` goes stale with the next DHCP lease;
`extra.apiUrl` overrides it and is what a real build sets. The idempotency key
belongs to the tap, not to `trigger()`: one UUID per press, held until the
backend gives a definite answer, so a retry after a network failure replays
rather than sending a second pulse. CORS became a `buildApp` option defaulting
to **off**, with a test either way — a shipped app is a native binary that
sends no `Origin`, so production never needs it.

`npm run stub-shelly -w backend` serves HTTPS with a certificate generated at
startup and written to the temp directory, so no private key is committed and
no verification step needs a real gate to move. It exists because the backend
only ever builds `https://` URLs — `ShellyConfig.insecure` is still reachable
only from the integration test, with no environment variable that can set it.

## Tested

`npm test` at the root: **183 backend + 4 shared passing.** All three
workspaces typecheck, `app` included.

Task 12 was driven end to end against the stub, over real HTTP, with the
compiled server: login, `reachable: true` (the first confirmation that the
state adapter's `online` walk handles a realistic nested response), a
`success` pulse, an identical key replaying as `replayed: true`, and a fresh
key inside the window rejected 409 with `retryAfterMs: 4980`. **The stub logged
three switch requests for five trigger calls** — the replay guard and the
cooldown each stopped one at the wire, and the body was
`{"id":"stub","channel":0,"on":true,"toggle_after":1}` exactly.

One scare worth recording: a mid-sequence tap returned `success` where a
cooldown rejection was expected. It was real seconds passing between two
tool calls, not a defect — re-running both taps inside a single invocation
gave the 409. Worth knowing before anyone else reads that as a bug.

`npx expo export --platform android` bundles 606 modules, which is what proves
the workspace module graph resolves (`@gate/shared` from `dist`, zod,
expo-crypto). SDK 52+ needs no `metro.config.js` for monorepos.

Every safety-critical invariant is proven by mutation — the test is shown
failing against a deliberately broken implementation before it counts. This has
repeatedly earned its keep: it caught a `Date` round-trip test passing by
accident, a window test with a six-hour gap that made an off-by-one
undetectable, and a boundary test that caught none of the three import shapes it
claimed to.

Task 11's four mutations, each reverted after the named test was watched
failing: spreading the use-case result into the response (the auth key appeared
in the 500 body verbatim — the failure output is the proof), wiring `(s) => s`
as the redactor, emptying the `USER_UNKNOWN → ACCESS_DENIED` map, and letting
`authGuard` fall through to an anonymous user (which served `/gate/status` a
200 and logged people out on a 204). Writing them also exposed a bad test of my
own: the auth-key-in-the-message check caught its own `expect.unreachable`, so
it would have passed against a config that never threw at all. Rewritten to
assert on the message.

Task 12's one mutation: flipping `allowCors` to default `true` — caught by
"sends no CORS headers by default", reverted.

## Next

**Plan one is complete. Milestone 6 is next.**

Task 12 step 6 ran on a **physical phone** on 2026-08-21, against the real
Shelly relay powered on a bench with nothing wired to its I/O terminals — so
the relay clicked audibly and no gate could move. All of it passed:

- create-user, login, and a wrong password refused
- `reachable: false` unplugged, `true` plugged in
- one tap → `success` and an audible click
- an immediate second tap → 409 `GATE_COOLING_DOWN` with `retryAfterMs`, **no
  second click** — the safety mechanism proving itself on real hardware
- a third tap after the window → success again

Two things that test settled beyond its checklist. Tokens really do reach the
keystore: `api.ts` keeps no token in memory and re-reads `expo-secure-store` on
every authenticated call, so "Check status" working *is* the proof. And the
reachability walk was confirmed against the live API in both directions (see
the open item below for what that did not prove).

Also observed, and normal: an unplugged relay kept reporting `reachable: true`
for about a minute before flipping to false. Shelly Cloud only marks a device
offline once its keepalive expires, so **`reachable` is a lagging indicator** —
it can describe a device that is already dead. This is why every status
response carries `checkedAt`, and another reason the no-retry rule exists.

Not carried forward, and deliberately: **Android cleartext HTTP** never became
a problem because Expo Go permits it. A standalone dev build would need
`expo-build-properties` with `usesCleartextTraffic`; not added until someone
builds one.

Every constraint carried into Task 11 was discharged: `verifyPassword` is the
real argon2id one, `POST /auth/logout` is a bare port call, both `Date` fields
serialise as ISO strings, `internalDetail` is stripped, `schema.sql` is copied
into `dist/`, and `ShellyConfig.insecure` has no environment variable that can
set it. The redactor wiring has its own test in `composition-root.test.ts`,
asserted behaviourally — an identity function fails it.

Standing notes:

- `npm test` at the root builds `shared/dist` first. `npm test -w backend`
  alone can run against a stale `@gate/shared` — use the root script.
- `*.db*` is gitignored, which matters: SQLite runs in WAL mode, and
  `gate.db-wal` holds committed data while `gate.db-shm` coordinates access to
  it. A bare `*.db` pattern catches neither.

## Open questions

None blocking.

**FIXED (2026-08-21).** `PulseResult.detail` was documented as "for the audit
log only" but `toResult` discarded it, so a failed pulse audited as
`failed / DEVICE_OFFLINE` with `detail` null. It now travels out on
`internalDetail`, which the decorator redacts and persists and the API layer
drops. Two tests cover it — one on the field, one across the whole join from
adapter to audit row — and both were watched failing against a `toResult` that
drops it again. The fix widened *which* responses carry `internalDetail`, so
`api.test.ts` gained a leak test on a 502 as well as the existing 500.

**Known gap, accepted — `FakeTokenService` has no shared contract test.**
Unlike `CommandGuardPort`, nothing binds it to `JwtTokenService`, so the two
can drift and the auth tests would keep passing while describing a service that
does not exist. Tolerated because single-use is proven directly against the
real implementation and `RefreshSessionUseCase` only distinguishes null from
non-null — no use-case logic depends on the fake's replay behaviour.

> **Revisit trigger, decided 2026-08-21:** write the contract test (mirroring
> `test/command-guard-contract.ts`) as soon as **either** `TokenServicePort`
> gains a method **or** a second real implementation appears — Redis-backed
> sessions, say. The same note is in `test/fakes.ts`, above the class, where
> whoever is about to break it will actually see it.

**Open, needs one command on real hardware — the reachability walk.**
`findOnline` in `state-adapter.ts` searches the Shelly response for `online`
at any depth instead of reading a known path. Physical testing on 2026-08-21
confirmed it works in both directions, so the old "unverified" comment was
retired — but that proved the walk *works*, not *where the flag lives*, since
the search finds it without reporting the path.

It stays loose until someone pins the path: it returns true if `online` is
truthy anywhere in the response, and the false-positive direction is the
dangerous one, claiming the gate is reachable when it is not. Only one device
id is ever requested, so nothing else should be in the payload today.

> **To close it:** run `npm run probe-shelly -w backend` with the relay
> powered — read-only, it calls `get` and never `set/switch`, so it cannot
> move a gate — then replace the walk with the exact path from the output.

**Licensing, decided 2026-08-21.** `app/LICENSE` — an MIT grant the Expo
template dropped into a subdirectory — was **deleted**. The repo has no root
licence, so the project is unlicensed: all rights reserved, which is the right
default for software that opens a front gate. A stray MIT grant covering one
folder was misleading either way it was read. **If this is ever published, add
a considered licence at the repository root then.**

`app/.claude/settings.json` and `app/AGENTS.md` / `app/CLAUDE.md` were kept.
The plugin config is low-risk and scoped, and the two-line agent instruction to
read version-pinned Expo docs has already earned its keep: it is why the SDK
docs were fetched rather than written from memory, immediately before the
Expo Go SDK 54 ceiling turned up.

## Deferred to a second plan

Milestone 6 (full app UI, biometric lock, activity list, icon and splash) and
milestone 7 (`README.md`, `ARCHITECTURE.md`). Plan two does not begin until
Task 12 has run on a **physical phone**, not a simulator.

## Deviations from SPEC.md

| Deviation | Why |
|---|---|
| A tenth port, `CommandGuardPort`, beyond the nine listed | Cooldown and idempotency are hot-path concurrency control. Routing them through `AuditLogPort` would mean pruning audit rows silently disables the cooldown. |
| `AccessPolicyPort.canOperate` takes 3 args, not 2 | A 2-arg policy would have to fetch grants itself, making the domain async and giving it a database dependency. The spec also demands the domain be unit-testable with zero I/O; purity is the requirement with teeth. |
| No signup endpoint; accounts via `create-user` CLI only | `SPEC.md` requires "how to add the first user" but defines no route. A CLI is the smaller attack surface for a door opener. |
| HTTPS enforced via a required `https://` `PUBLIC_URL`, not by terminating TLS in Node | TLS belongs at the reverse proxy. The process still refuses to boot without it. |
| `GET /access-grants` (list) not built | `SPEC.md` specifies issue and revoke only. |
| `buildApp(container)`, not `buildApp(config)` as the plan wrote it | Taking the container is what lets `api.test.ts` run the whole HTTP layer against fakes. A `buildApp(config)` would construct the real Shelly adapter, and every test would be one bad mock away from moving a real gate. |
| `create-user` lives at `backend/src/scripts/`, not `backend/scripts/` | Keeps it inside `rootDir: src`, so it compiles to `dist/scripts/create-user.js` with everything else instead of needing its own build config. |
| CORS is a `buildApp` option, not a line in `server.ts` as the plan wrote it | "Off in production" is a security switch, and one that only exists in the entry point cannot be tested. `server.ts` still owns the decision; `buildApp` owns the behaviour, and both directions have a test. |
| The API base URL comes from Metro's `hostUri`, not from `extra.apiUrl` in `app.json` | The plan's own reasoning, followed one step further: a phone cannot resolve the dev machine's `localhost`, and a hand-pasted LAN IP is stale the next time the router reassigns. `extra.apiUrl` still overrides, and is what a real build sets. |
| No `metro.config.js` | Expo SDK 52+ configures Metro for monorepos itself; the documented config is now the *pre*-52 workaround. Proven by `expo export` bundling 606 modules. |
