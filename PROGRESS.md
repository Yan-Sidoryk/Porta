# Progress

Resume point for a fresh session: read this file, then
`docs/superpowers/specs/2026-08-19-gate-opener-design.md` (the design) and
`docs/superpowers/plans/2026-08-19-gate-opener-backend.md` (the task list).
Those two plus `git log` are enough to know exactly where things stand.

Execution ledger with every ruling:
`.superpowers/sdd/2026-08-19-gate-opener-backend/progress.md` (git-ignored).

## Status: milestone 1–5 plan in execution, Task 4 of 12

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

## In progress

**Task 4 — `TriggerGateUseCase`**, the core safety logic. Implemented and
reviewed; in fix round 1 for three Important findings:

1. `execute()` had no `try/catch`, so adapter rejections crossed the layer
   boundary. Fail-closed direction was already correct.
2. A replayed *failure* could not report `replayed: true`, and no test covered
   replay-of-a-failure at all.
3. The idempotency-before-cooldown ordering was enforced only inside the test
   fake, with nothing forcing Task 7's real SQLite guard to agree. Being fixed
   with a shared contract test both implementations must pass.

## Tested

`npm test` at the root. 20 backend tests + 3 shared passing as of Task 4's first
commit. Every safety-critical invariant is proven by mutation — the test is
shown failing against a deliberately broken implementation before it counts.

## Next

Tasks 5–12: auditing decorator, SQLite repositories, the atomic command guard,
Shelly adapters, auth infrastructure, remaining use cases, API + composition
root, and the Expo vertical slice.

## Open questions

None blocking.

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
