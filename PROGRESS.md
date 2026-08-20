# Progress

Resume point for a fresh session: read this file, then
`docs/superpowers/specs/2026-08-19-gate-opener-design.md` (the design) and
`docs/superpowers/plans/2026-08-19-gate-opener-backend.md` (the task list).
Those two plus `git log` are enough to know exactly where things stand.

Execution ledger with every ruling:
`.superpowers/sdd/2026-08-19-gate-opener-backend/progress.md` (git-ignored).

## Status: Task 12 of 12 written; **the physical-phone check is still owed**

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

`npm test` at the root: **180 backend + 4 shared passing.** All three
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

**Task 12 step 6 is not done, and I could not do it.** Everything above was
verified from this machine; steps 4 and 5 of that checklist need a phone in a
hand. Plan two does not begin until this has run on a **physical device**, not
a simulator. Four terminals from a clean checkout:

```
npm install && npm run build
npm run stub-shelly -w backend          # prints SHELLY_HOST and NODE_EXTRA_CA_CERTS
# put those two into .env, then:
npm run create-user -w backend -- --email you@example.com --password '...' --role owner
npm start -w backend
npm start -w app                        # scan the QR code in Expo Go
```

What is still unproven, and what to watch for:

- **Tokens actually landing in the keystore.** `expo-secure-store` is the one
  module here that cannot be exercised off-device at all.
- **Android cleartext HTTP.** Expo Go permits it, so the slice should just
  work; a standalone dev build will not, and would need
  `expo-build-properties` with `usesCleartextTraffic`. Not added — YAGNI until
  someone builds one.
- **The cooldown countdown on screen** is milestone 6, not this slice. Tapping
  twice quickly shows the raw `retryAfterMs` as text, which is all step 6.6
  asks for.

Every constraint carried into Task 11 was discharged: `verifyPassword` is the
real argon2id one, `POST /auth/logout` is a bare port call, both `Date` fields
serialise as ISO strings, `internalDetail` is stripped, `schema.sql` is copied
into `dist/`, and `ShellyConfig.insecure` has no environment variable that can
set it. The redactor wiring has its own test in `composition-root.test.ts`,
asserted behaviourally — an identity function fails it.

Standing notes:

- `npm test` at the root builds `shared/dist` first. `npm test -w backend`
  alone can run against a stale `@gate/shared` — use the root script.
- `app/.claude/settings.json` arrived with the Expo template and enables an
  Expo Claude plugin. Committed as scaffolded; delete it if unwanted.
  `app/LICENSE` is template MIT and the repo has no root licence — worth a
  decision before this goes anywhere public.

## Open questions

None blocking.

Known gap, found during Task 11's smoke test, **not** fixed — it belongs to
Task 4 and the spec does not require it: `PulseResult.detail` is documented as
"for the audit log only", but `toResult` discards it, so a failed pulse audits
as `failed / DEVICE_OFFLINE` with `detail` null. Only a *thrown* adapter error
reaches the audit row (as `internalDetail`). SPEC.md asks for user, timestamp,
outcome and error code, and all four are recorded, so this is lost diagnostic
text rather than a missing requirement. Worth three lines in `trigger-gate.ts`
whenever that file is next opened.

Known gap, accepted: `FakeTokenService` mirrors `JwtTokenService`'s single-use
refresh semantics but no shared contract test binds them, as `CommandGuardPort`
has. Judged tolerable because single-use is proven directly against the real
implementation and no use-case logic depends on the fake's replay behaviour —
`RefreshSessionUseCase` only distinguishes null from non-null. Revisit if a
second implementation appears.

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
