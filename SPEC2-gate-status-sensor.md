# Build prompt: gate status sensor

Paste everything below the line into Claude Code. Fill in the placeholders in the
Configuration section first — you can only get them once the hardware is installed.

---

## Context

The gate opener works. This adds position sensing, which the design document
anticipated: `GateStatePort` currently resolves to `UnknownPositionStateAdapter`,
and this task replaces it with a real implementation.

New hardware, already installed:

- A **Shelly Plus Add-on** seated on the existing Shelly 1 Gen4 via its plug-in
  header. Galvanically isolated, drawing 3.3 V from the host.
- A **Gebildet MC-58 reed contact** (3-wire, NC leg used) wired to the Add-on's
  `DIGITAL IN` and `GND`. Contact on the fixed pillar, magnet on the gate leaf
  that closes last.
- Circuit closed = magnet present = that leaf is closed.

Physical setup already done, so you can assume it: the Add-on is enabled in
device settings, the input is set to **detached** (critical — otherwise the input
drives the relay and the gate reopens itself on every close), and the input's
component id has been discovered via `Shelly.GetStatus`.

## What the sensor actually tells you

It reports **closed** or **not closed**. It does not report *open*.

A gate stopped mid-travel, a gate standing fully open, and a gate with one leaf
jammed all read identically. Do not label any of them "open" anywhere in this
system. Being honest about this is a requirement, not a stylistic preference —
a status display that confidently says "Open" when it means "not closed" is worse
than one that says nothing.

## Domain change

`GateState.position` currently is `'open' | 'closed' | 'unknown'`. Change it to:

```ts
type GatePosition = 'closed' | 'not_closed' | 'unknown'
```

This is a deliberate revision. The earlier plan mapped a broken circuit to
`unknown`, but that discards real information — "not closed" is a genuine,
useful state and deserves its own name. `unknown` is now reserved for cases where
the system truly has no reading: before the first report, after a restart with no
persisted state, or when the data is too stale to trust.

Update every consumer of this union. There should be no `'open'` string left in
the codebase when you're done.

**The ripple was checked before this spec was revised, and it is nil.**
`shared/src/vocabulary.ts:4` holds the only `'open'` literal in source. No
production code in `backend/` or `app/` branches on `position` — the app reads
only `reachable` and `checkedAt`. Everything else is prose in `SPEC.md`,
`README.md`, `ARCHITECTURE.md` and `docs/DEPLOY.md`, plus two app test fixtures
that already say `'closed'`. Complete the migration in one pass.

## Backend

### Primary path: webhook (push)

The Shelly supports outbound webhooks on input state change — events
`input.toggle_on` and `input.toggle_off`. The device makes an HTTP call the
moment the contact changes, so no polling is needed for liveness. This works
through any firewall because it's outbound from the device.

**Shelly Gen2 webhooks are plain `GET` requests with no body.** `Webhook.Create`
takes a `urls[]` array and the device fetches those URLs; there is no JSON event
payload to parse. So the event goes in the path, one registered URL per event:

```
Webhook.Create  event: input.toggle_on
                urls:  [ https://<backend>/webhooks/gate-state/<token>/closed ]

Webhook.Create  event: input.toggle_off
                urls:  [ https://<backend>/webhooks/gate-state/<token>/not-closed ]
```

Add `GET /webhooks/gate-state/:token/:reading`:

- Validate `:token` against `GATE_STATE_WEBHOOK_TOKEN` in constant time.
- `:reading` is `closed` or `not-closed`. Anything else is rejected.
- On any rejection, answer with **exactly what an unknown path answers** — today
  that is `400 BAD_REQUEST` from `setNotFoundHandler`, not 404. The goal is not
  to confirm the endpoint exists, and a lone 404 among 400s would be precisely
  the tell it was meant to avoid. Match the not-found handler, whatever it
  returns.
- Map the reading to a position and store it with a timestamp. The write is a
  synchronous in-memory assignment, so there is nothing to defer past the
  response.
- Return 200 quickly. The device does not wait around.
- Rate limit by IP, generously — a bouncing reed chatters, and dropping real
  events is worse than accepting a few extra.

**This endpoint must only be able to report state. It must never be able to
trigger the gate.** Different token from anything on the trigger path, no shared
auth, no code path from here into `TriggerGateUseCase`.

Webhooks are fire-and-forget: no retries, no queue, no delivery guarantee. A
missed event is gone permanently. Design accordingly — see reconciliation below.

The token travels in the URL path, which is the one place Shelly gives us — the
device cannot send custom headers. That means it lands in the request log unless
something stops it: the pino `req` serializer must rewrite the webhook path, and
the reverse proxy's access log needs the same treatment.

### Secondary path: reconciliation poll

A slow poll exists solely to correct drift from missed webhooks, not to provide
liveness.

- Every 60 seconds, and on backend startup.
- Read the input state through the same Shelly Cloud path the trigger already
  uses. `POST /v2/devices/api/get` returns the input state alongside the rest of
  the device status.
- If it disagrees with stored state, the poll wins — it is a direct read.
  Log the correction at warn level; frequent corrections mean webhooks are being
  lost and that's worth knowing.
- Respect the existing 1 req/s Shelly rate limit.

Do not poll faster to compensate for webhook problems. Fix the webhooks.

**Verify the response shape before writing the parser.** The current state
adapter admits it never confirmed where `online` lives and searches the whole
reply for it. Run `npm run probe-shelly -w backend` and read the real structure
first. If the Add-on input is not present in the cloud `get` reply at all, stop
and say so — reconciliation has no other source.

### Storage

**In memory, plus the startup poll. No table, no migration.**

An earlier draft of this spec called for a durable `gate_state` row, and then
required that it be treated as `unknown` on boot until the first poll confirms
it — because the gate may have moved while the backend was down. Since the poll
runs at startup, the persisted row changed no behaviour whatsoever. It was
storage that could only ever be overwritten before it was read.

What is held, in module-private fields on the adapter:

- `position` — the enum above
- `observedAt` — when the change happened
- `confirmedAt` — when we last had *any* successful reading, push or poll
- `source` — `'webhook' | 'poll'`, for debugging

Restart safety comes from the boot poll, not from a row. A restart starts
`unknown` and resolves within a second.

### Staleness

`GateStatePort.getState()` returns `unknown` if `confirmedAt` is older than
`GATE_STATE_STALE_AFTER_MS` (default 5 minutes). Report the real `confirmedAt`
alongside, and the last real reading underneath it, so the app can say both what
it last saw and how old that is.

Stale is not an error. It means the Shelly is unreachable — Wi-Fi at the pillar
drops, that's the expected failure — and the honest answer is that we don't know.

### Interaction with triggering

After a pulse the gate is moving, so any stored position is immediately wrong.
Mark the state `unknown` and let the next webhook or poll resolve it.

**On `success` *and* on `timeout`.** A timed-out request may well have delivered
the pulse, and the design document's §4.2 doctrine is that the outcome knowing
least resolves most conservatively — an ambiguous timeout must not leave
"Closed" on screen while the gate swings open. A confirmed `device-offline`
leaves the state alone: nothing moved.

Do not optimistically predict the new position from the old one. PP is
open-stop-close-stop, the gate may have been mid-travel, and after a power cut
the first command is always Open. Prediction here is guessing dressed as data.

### Adapter

`ReedSwitchStateAdapter implements GateStatePort`, reading from its own held
state rather than calling Shelly synchronously. Swap it in at the composition
root — `UnknownPositionStateAdapter` stays in the codebase, unused, as the
documented fallback.

**`reachable` must survive this change.** The port returns
`{ position, reachable, checkedAt }`, and the app renders `reachable` as
"Controller online / offline". An adapter that never calls Shelly would silently
drop that fact. The reconciliation poll reads `online` from the same reply it
reads the input from, so both are kept — and they stay distinct, because Shelly
Cloud lags a device offline by up to a minute and "we could not ask" is not the
same fact as "the controller is down".

Contact polarity is configurable via `REED_LOGIC_INVERTED` (boolean, default
false). Which way the NC leg reads will be confirmed with a multimeter on
install, and it must not require a code change to correct. One helper does the
mapping for both the webhook and the poll, so the flag cannot invert one and not
the other.

## App

**Extend the status line that already exists.** `StatusPanel` sits above the
button and shows controller reachability today; its doc comment argues position
should never be shown, which was correct until this hardware existed. Position
becomes the headline and reachability demotes to the qualifier on the same row,
rather than adding a second row to a panel that must stay visibly secondary to
the button.

Four states, each with distinct text:

```
● Closed                    Checked 21:34
● Not closed                Checked 21:34
● Unknown                   Checked 21:34
  Last seen closed 12 minutes ago
● Unknown
  No connection to the gate service.
```

- **Closed** — the only confident positive state
- **Not closed** — never render this as "Open"
- **Unknown** — no reading yet, or the gate is moving
- **Unknown, last seen closed 12 minutes ago** — stale, with relative age

Requirements:

- Never encode state in colour alone. Text carries the meaning; colour supports it.
- No gate iconography implying a position.
- The status must be visibly secondary to the button. This is a gate opener that
  happens to show status, not a dashboard.
- Refresh on app foreground and after a trigger completes. The screen currently
  declines to re-read status after a tap because that call spent the Shelly
  1 req/s slot; it now reads from memory, so that reasoning no longer holds and
  the comment explaining it should go.
- **While the position is `unknown`, keep asking until it resolves.** The
  refresh fired straight after a tap can only ever read `unknown` -- the gate
  has only just started moving -- so on those four triggers alone a user who
  taps and then watches the screen sits on a frozen `Unknown` long after the
  webhook told the backend the gate had finished closing. That is the single
  moment this whole feature exists for: driving away and wanting to know the
  gate shut behind you. Re-ask every ~3s, stop the moment a real reading lands,
  and give up after ~90s -- a gate resolves within a swing, and even one
  stopped mid-travel reads `not_closed`, so a position still unknown by then
  means the sensor is broken rather than the gate being slow. This hits the
  backend's own memory, not Shelly, so it costs nothing from the 1 req/s
  budget. Do NOT auto-retry a backend that was unreachable: that is a
  different failure, and a 3s timer aimed at it is a retry storm.
- If the backend is unreachable, show `Unknown` — never the last cached value
  without an age on it.

## Testing

- Webhook handler: valid token, invalid token, both readings, an unknown
  `:reading` segment, and that a rejection is indistinguishable from an unknown
  path.
- Reconciliation: poll disagrees with stored state and wins; poll fails and state
  goes stale rather than throwing.
- Staleness boundary either side of the threshold, using the injected `ClockPort`.
- Trigger resets position to `unknown` on `success` and on `timeout`, and leaves
  it alone on `device-offline`.
- `REED_LOGIC_INVERTED` flips the mapping in both directions.
- No test may call the real Shelly API.

## Configuration

```
SHELLY_INPUT_COMPONENT_ID=<from Shelly.GetStatus, typically 100+, not 0>
GATE_STATE_WEBHOOK_TOKEN=<generate: openssl rand -hex 32 -- hex, not base64:
#                           it rides in a URL path and base64 can contain '/'>
GATE_STATE_STALE_AFTER_MS=300000
GATE_STATE_POLL_INTERVAL_MS=60000
REED_LOGIC_INVERTED=false
```

Add all of these to `.env.example` with placeholders. The webhook URLs to
register on the device are
`https://<your-backend>/webhooks/gate-state/<token>/closed` and
`.../not-closed` — document both in the README, including how to register them
via the Shelly UI or the `Webhook.Create` RPC method, and note that the path
carries a secret and must be kept out of access logs.

## Out of scope

- Open/closed percentage, or any inference of partial position.
- Notifications or alerts on state change.
- Auto-close when left open. The R70 board has its own auto-close on a DIP
  switch; a software version would fight it.
- History or graphs of gate state.

## Before you start

State your plan and flag anything here you disagree with rather than working
around it.
