# Progress

Resume point for a fresh session: read this file, then
`docs/superpowers/specs/2026-08-19-gate-opener-design.md` (the design) and
`docs/superpowers/plans/2026-08-19-gate-opener-backend.md` (the task list).
Those two plus `git log` are enough to know exactly where things stand.

## Status: planning complete, implementation not started

## Done

- Secrets isolated. `SPEC.md` arrived with a live Shelly auth key and JWT secret
  in plaintext. They were moved to a gitignored `.env` **before the first
  commit**, so they were never in git history and need no rotation. `SPEC.md`
  tracks placeholders only.
- Design doc written, reviewed twice, and committed. Two defects were caught in
  review and fixed:
  - The cooldown was blind during the in-flight Shelly request — the exact
    window it exists to protect. Fixed by claiming before calling.
  - The claim-time window was inverted: an abandoned claim got a *weaker*
    guard than a timeout despite carrying less information. Fixed by writing
    the pessimistic 2x window at claim time and narrowing only on evidence.
  - Auditing moved out of the numbered step list into a decorator, because
    steps 1–2 return early and denied attempts would never have been logged.
- Implementation plan written for milestones 1–5 (12 tasks, TDD throughout).

## Next

Task 1 of `docs/superpowers/plans/2026-08-19-gate-opener-backend.md` —
workspace scaffold and the `/shared` Zod contract.

## Tested

Nothing yet. No code has been written.

## Open questions

None blocking. Both design-review questions are resolved and recorded in §16
of the design doc.

## Deferred to a second plan

Milestone 6 (full app UI, biometric lock, activity list, icon and splash) and
milestone 7 (`README.md`, `ARCHITECTURE.md`). Both depend on the Task 12
vertical slice actually working on a physical device; planning them earlier
would be planning on assumptions.

## Deviations from SPEC.md

| Deviation | Why |
|---|---|
| A tenth port, `CommandGuardPort`, beyond the nine listed | Cooldown and idempotency are hot-path concurrency control. Routing them through `AuditLogPort` would mean pruning audit rows silently disables the cooldown. |
| No signup endpoint; accounts via `create-user` CLI only | `SPEC.md` requires "how to add the first user" but defines no route. A CLI is the smaller attack surface for a door opener. |
| HTTPS enforced via a required `https://` `PUBLIC_URL`, not by terminating TLS in Node | TLS belongs at the reverse proxy. The spec's requirement is met — the process refuses to boot without it — without making cert renewal the app's problem. |
| `GET /access-grants` (list) not built | `SPEC.md` specifies issue and revoke only. |
