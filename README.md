# <img src="docs/logo-rounded.png" alt="" width="24"> Porta

Opens and closes a physical driveway gate from a phone.

This is safety-relevant software. A bug here moves a heavy metal gate in the
real world, so the whole system is built to be conservative: it never invents
state it does not have, it never retries a command it is not sure about, and it
refuses to start rather than run misconfigured.

---

## The hardware, and why the software looks like this

You cannot change any of this, and every design decision below follows from it.

```
app  →  backend  →  Shelly Cloud  →  Shelly 1 Gen4  →  R70/2AC  →  gate
```

- A **Roger Technology R70/2AC** control board drives the gate. It owns all
  motion logic, safety inputs and auto-close. This software does not control
  motors.
- A **Shelly 1 Gen4** relay bridges the R70's **PP (step-by-step)** input.
  Closing that contact briefly is exactly like pressing the physical remote.

Three consequences shape everything:

**1. There is one command, a pulse.** No "open", no "close". The R70's PP
sequence is open → stop → close → stop, so what a pulse does depends on what
the gate is currently doing. The app shows a single button for this reason —
two buttons would be a lie.

**2. A second pulse mid-travel stops the gate.** This is the main failure mode
the system exists to prevent. It is why there is a cooldown, why the same tap
retried never sends a second pulse, and why a timed-out request is *never*
retried automatically.

**3. The sensor knows closed, and nothing else.** A reed contact on the pillar
reports `closed` or `not_closed` — never `open`. A gate stopped mid-travel, a
gate standing fully open, and a gate jammed on one leaf are the same reading,
so calling any of them "open" would be a claim about three situations and
wrong in two. `unknown` is reserved for genuinely having no reading: nothing
seen yet, the gate moving after a pulse, or a reading too stale to trust.
Position is never inferred from command history — a gate app that confidently
says "Closed" when it doesn't know is worse than one that admits ignorance.

The physical remote keeps working and anyone can use it at any time, so cached
state is never authoritative.

---

## What the backend is

A small HTTP service. It is the only component that ever talks to Shelly, and
the only place the Shelly credential exists.

It exists because the alternative — the phone talking to Shelly directly —
would put an **account-wide, non-expiring** Shelly key on every phone. Anyone
extracting it would control every device on the account, forever. Instead the
phone gets a 15-minute token for one narrow API.

The backend owns:

- **Authorisation** — who may operate the gate, and when.
- **The cooldown and idempotency guard** — the safety logic above.
- **The audit log** — who tried what, and what happened. Failed and denied
  attempts matter more than successful ones.
- **The Shelly credential** — which never leaves the process.

### Layout

```
domain/          entities, ports, typed errors. Zero outward imports.
application/     use cases. Depend only on domain ports.
infrastructure/  adapters: Shelly, SQLite, JWT, argon2, clock, rate limiter.
api/             thin Fastify routes: parse, call a use case, map the result.
composition-root.ts   the only file that names a concrete adapter.
```

Dependencies point inward only. Swapping Shelly Cloud for local network
control is a one-line change in `composition-root.ts` — see `gateCommand`.

Repository layout:

| Path | What |
|---|---|
| `backend/` | the HTTP service |
| `shared/` | Zod schemas and types for the API contract, used by both sides |
| `app/` | Expo mobile app |
| `SPEC.md` | the original build brief |
| `PROGRESS.md` | current state, decisions, and what is still owed |

---

## Requirements

- **Node 20.6+** (the scripts use `node --env-file`). Developed on 25.2.1.
- npm 10+ (workspaces).
- A Shelly Cloud account with the gate's Shelly 1 Gen4 registered.
- For the phone app: **Expo Go**, and a phone on the same Wi-Fi as your dev
  machine.

---

## Setup

### 1. Install

```bash
npm install
```

This installs all three workspaces. `shared` builds itself on install — the
backend imports it as a compiled package.

### 2. Create `.env` **in the repository root**

Not in `backend/`. The scripts read `../.env` relative to the backend
workspace, so the file belongs at the top level. It is gitignored and must stay
that way.

```bash
cp .env.example .env
```

Then fill it in:

| Variable | Required | What it is |
|---|---|---|
| `SHELLY_HOST` | yes | Your account's Shelly server, e.g. `shelly-53-eu.shelly.cloud` |
| `SHELLY_AUTH_KEY` | yes | Account-wide Shelly cloud key |
| `SHELLY_DEVICE_ID` | yes | The relay's device id |
| `JWT_SECRET` | yes | **At least 32 characters.** Random, not a passphrase |
| `GATE_COOLDOWN_MS` | yes | `5000` unless you have a reason |
| `DATABASE_PATH` | yes | `./gate.db` — relative to `backend/` when started via npm |
| `PUBLIC_URL` | yes | How the service is reached. Must be `https://` in production |
| `NODE_ENV` | yes | `development`, `test`, or `production` |
| `PORT` | no | Defaults to `3000` |
| `HOST` | no | Defaults to `0.0.0.0`, which is what lets a phone reach it |

Generate a secret with:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

The service **refuses to boot** if any required variable is missing, naming the
ones that are wrong and never printing their values. That is deliberate: you
find out at deploy time, not at 2am.

#### Getting the three Shelly values

All of them come from the Shelly Cloud web control panel (`control.shelly.cloud`):

- **`SHELLY_AUTH_KEY` and `SHELLY_HOST`** come from the same place — the user
  settings area, under authorisation / cloud key. The dialog that reveals the
  key also shows the **server URL** for your account; strip the scheme and use
  the hostname (`shelly-53-eu.shelly.cloud`). Accounts are pinned to a
  particular server, so this is not the same for everyone. Menu wording shifts
  between Shelly UI versions — look for "cloud key" or "authorization cloud key".
- **`SHELLY_DEVICE_ID`** is on the device's own settings/info page, usually
  labelled device ID.

> **The auth key is account-wide and does not expire.** Anyone holding it
> controls every device on the account. It belongs in `.env` and nowhere else —
> never in the app, never in a commit, never in a log.

### 3. Build

```bash
npm run build
```

The backend runs from compiled output, so this is required before starting.

### 4. Create the first user

There is no signup endpoint — deliberately. A door opener with public
registration is a door opener anyone can register for. Accounts are created
with a CLI, on the host:

```bash
npm run create-user -w backend -- --email you@example.com --password 'a-real-password' --role owner
```

The `--` matters; without it npm eats the flags. It prints the new user's id.

Roles: `owner` can always operate the gate and can issue access grants.
`user` can do **nothing** until an owner grants them a time window — that is
the default branch, not an oversight.

> The password is a command-line argument, so it lands in your shell history
> and in `ps` output. Run this on the host and clear the history line after.

### 5. Run

```bash
npm start -w backend
```

---

## Managing users and access

### More users

Same CLI, on the host. `--role` defaults to `user`, so it can be omitted:

```bash
npm run create-user -w backend -- --email them@example.com --password 'something' --role user
```

**Save the UUID it prints.** You need it to issue a grant, and there is no
list-users endpoint. If you lose it:

```bash
sqlite3 backend/gate.db "select id, email, role from users;"
```

There is no password-change flow. Changing someone's password means creating
the account again with a new one.

### Roles

**`owner`** can always operate the gate, no grant required, and is the only role
that can issue or revoke grants. You can have as many owners as you like —
`--role owner`.

**`user`** can do **nothing** until an owner grants them a window. That is the
default branch of the access policy, not an oversight: a freshly created account
is inert, and a revoked grant denies immediately rather than falling back to
something permissive.

### Temporary access

Grants are the mechanism, and they are **API-only** — the guest UI is out of
scope, so there is nothing for this in the app. First get an owner's token:

```bash
curl -X POST http://<host>:3000/auth/login \
  -H "content-type: application/json" \
  -d '{"email":"you@example.com","password":"..."}'
```

Then issue the grant with the `accessToken` from that response:

```bash
curl -X POST http://<host>:3000/access-grants \
  -H "authorization: Bearer <accessToken>" \
  -H "content-type: application/json" \
  -d '{"userId":"<their-uuid>","startsAt":"2026-08-22T09:00:00.000Z","endsAt":"2026-08-22T18:00:00.000Z"}'
```

Times are ISO-8601 UTC. An inverted or empty window is rejected, so the owner
finds out immediately rather than the guest finding out at the gate. Access
tokens last 15 minutes, so fetch a fresh one if the call comes back 401.

**Save the `grantId` it returns** — you need it to revoke, and `GET
/access-grants` was deliberately not built. If you lose it:

```bash
sqlite3 backend/gate.db "select id, user_id, starts_at, ends_at, revoked_at from access_grants;"
```

### Revoking

Any time, and it takes effect on the **very next tap** — the policy re-checks
grants on every trigger, so there is no session to wait out:

```bash
curl -X DELETE http://<host>:3000/access-grants/<grantId> \
  -H "authorization: Bearer <accessToken>"
```

Returns `204`. Revoking an id that does not exist also returns `204`,
deliberately: an honest `404` would turn this endpoint into a probe for which
grant ids are real.

### Cutting someone off entirely

Revoking the grant is the intended lever for a `user`. For an owner — or to
disable an account outright — there is currently **no endpoint or CLI**. The
`disabled` column exists and every path honours it (the account is refused and
its refresh tokens are revoked the next time it tries to refresh), but nothing
sets it:

```bash
sqlite3 backend/gate.db "update users set disabled = 1 where email = 'them@example.com';"
```

---

## Running it without moving a real gate

**Every trigger against a real `SHELLY_HOST` moves the actual gate.** For
development, point the backend at the bundled stub instead:

```bash
npm run stub-shelly -w backend
```

It prints the two values to use:

```
SHELLY_HOST=127.0.0.1:8443
NODE_EXTRA_CA_CERTS=<path to a certificate it generated>
```

Put the first in `.env` and set the second in the environment before starting
the backend. The stub speaks HTTPS because the backend only ever builds
`https://` URLs — there is no environment variable that can downgrade that.
The certificate is generated fresh at startup into the temp directory, so no
private key is ever committed.

The stub logs every request it receives, which is how you can prove the
cooldown and replay guards are working: tap twice quickly and you will see
**one** switch request, not two.

---

## The mobile app

```bash
npm start -w app
```

Scan the QR code with Expo Go, on a phone on the same Wi-Fi.

The app finds the backend automatically: it reads the LAN address Metro is
already serving the bundle from and targets port 3000 there. A phone cannot
resolve your machine's `localhost`, and an IP pasted into `app.json` goes stale
the next time your router hands out a lease. To override — which is what a real
build does — set `extra.apiUrl` in `app/app.json`.

Tokens are stored with `expo-secure-store` (iOS keychain / Android keystore),
never `AsyncStorage`. A returning user goes straight to the gate screen; only
the presence of a token is checked at launch, and an expired one is refreshed
where it surfaces.

The app is pinned to **Expo SDK 54** to match the Expo Go available on the
target phone.

Expect a Windows Firewall prompt for Node the first time a phone connects.

### The screen

One screen, forced dark, no system theme. One round button, low and centred so
it falls under a thumb one-handed. It is deliberately not a consumer smart-home
app: the reference is a key fob or an e-stop panel, because that is what it is.

No gate iconography. The gate's position is the largest thing on the screen —
**CLOSED** in green, **OPEN** in amber — because the real usage is a glance
from a car that is already moving. Controller reachability sits above it in
small type, since it answers a different and rarer question.

When the position can no longer be confirmed, the last reading is greyed under
a small **LAST SEEN** label rather than collapsing to a bare UNKNOWN. More
useful and no less honest: the word is what was last seen, and the grey and
the label both say the app is no longer standing behind it. When and why it is
unconfirmed live in the line above — "Controller offline", "Last seen 15:02" —
and are not repeated.

**"OPEN" is a deliberate simplification.** The sensor reports a magnet or no
magnet, so a gate standing fully open, one stopped mid-travel, and one jammed
on a leaf are the same reading — `not_closed`. That word is what the API, the
domain and the audit trail use. The screen says OPEN because the question a
driver is actually asking is "do I need to turn around", both cases answer it
the same way, and a negation is slow to read at arm's length. The imprecision
is confined to one rendering function.

State is never carried by colour alone, and the reading is a lagging one: the
physical remote works whether the app is running or not, a missed webhook is
only corrected on the next poll, and Shelly marks a device offline only once
its keepalive expires. So a stale reading shows its age — "Last seen closed 12
minutes ago" — rather than going quiet or standing there looking current. A
check that fails reads UNKNOWN too: not reaching the gate service says nothing
about the gate.

While the gate is moving the status resolves itself. A tap necessarily leaves
the position unknown, so the screen keeps asking every few seconds until a real
reading lands — you can tap, drive off, and watch it flip to CLOSED without
pulling to refresh. That polling is against the backend's own memory, not
Shelly, and it gives up after about ninety seconds.

A result message from a tap borrows the same strip for six seconds and then
hands it back to the position.

After a tap the button disables itself for the cooldown, with the wait counting
down on the button itself. The duration always comes from the server's
`retryAfterMs` and is never assumed, so a doubled window after an unconfirmed
attempt is visible as a longer wait.

### Recent activity

Every gate attempt, successful or not, with who made it. Green worked, amber is
the gate protecting itself, red is everything that did not happen.

| Label | Colour | Meaning |
|---|---|---|
| **Pulse sent** | green | The pulse reached the relay and Shelly confirmed it. |
| **Repeat tap** | green | The same tap arrived twice inside 60s. The original result was replayed — **no second pulse was sent**. |
| **Cooling down** | amber | Blocked by the cooldown (doubled after an unconfirmed attempt). Nothing was sent. |
| **Access denied** | red | Refused: unknown account, no valid grant, or a disabled account. |
| **Rate limited** | red | Hit the per-user or per-IP request limit — the DoS guard, not the cooldown. |
| **Controller offline** | red | Shelly says the relay is unreachable. Usually power or Wi-Fi at the pillar. |
| **Controller refused** | red | Shelly received the command and rejected it. |
| **Unconfirmed** | red | Shelly did not answer in time. **The pulse may or may not have fired.** |
| **Unknown failure** | red | Anything else: a backend error, an unregistered device, a malformed request. |

No label claims a physical outcome. The hardware takes one command — a pulse —
and the R70 cycles open → stop → close → stop, so "Pulse sent" is the most that
can honestly be said about what happened at the gate.

**Unconfirmed** is the row that matters most. It is the one case where the
command may have gone through despite the failure, which is why nothing in the
stack ever retries it automatically.

**How much is shown, and how much is kept.** The list shows **every user's**
attempts, not just your own — that is the point of it, and something to weigh
before issuing a guest grant, since a guest can then see the gate's whole
history.

| Layer | Limit |
|---|---|
| App | The **20** most recent, newest first. Pull down to re-fetch |
| API | Caps any request at **200** (`GET /audit?limit=n`) |
| Database | **Nothing is deleted.** Every attempt is kept indefinitely |

There is no pagination in the app, so older entries are reachable only by
calling `GET /audit?limit=n` or reading `gate.db` directly. The table grows by
roughly one row per gate attempt — a few hundred KB a year at household
volume, which is why it is never pruned.

### Biometric lock

Off by default, in the menu behind the three dots at the top right, alongside
sign out.

It is not a second factor — the backend only ever sees an access token and this
check never leaves the phone. What it buys is narrow: it stops someone holding
your already-unlocked phone from opening the gate. It re-locks on returning
from the background after a short grace period, not only on a cold start, since
phone apps are rarely killed.

There are always two ways past that do not depend on the sensor: the device
passcode, and signing out to use your password. A wet finger or a failed reader
must never leave you standing outside your own gate.

**Face ID does not work in Expo Go** — it needs a development build. Android
fingerprint works in Expo Go.

---

## API

All routes except login and refresh need `Authorization: Bearer <accessToken>`.

| Method | Path | Body | Returns |
|---|---|---|---|
| `POST` | `/auth/login` | `{email, password}` | `{accessToken, refreshToken}` |
| `POST` | `/auth/refresh` | `{refreshToken}` | `{accessToken, refreshToken}` |
| `POST` | `/auth/logout` | — | `204` |
| `POST` | `/gate/trigger` | `{idempotencyKey}` (uuid) | `{ok, outcome, replayed}` |
| `GET` | `/gate/status` | — | `{position, reachable, checkedAt, lastReading}` |
| `GET` | `/webhooks/gate-state/:token/:reading` | — | `{ok}` — the Shelly's push, no session |
| `GET` | `/audit?limit=n` | — | recent events, newest last |
| `POST` | `/access-grants` | `{userId, startsAt, endsAt}` | `{grantId}` |
| `DELETE` | `/access-grants/:id` | — | `204` |

Access tokens last 15 minutes. Refresh tokens are single-use and rotate: using
one revokes it and issues a replacement, so a stolen token cannot be replayed.
Disabling an account revokes its outstanding refresh tokens immediately.

### Registering the position webhook

The Shelly pushes contact changes outbound, so nothing at the gate end needs to
be reachable from the internet. Gen2 webhooks are plain `GET`s with no body —
`Webhook.Create` takes a list of URLs and the device fetches them — so each
event gets its own URL:

| Event | URL |
|---|---|
| `input.toggle_on` | `https://<backend>/webhooks/gate-state/<token>/closed` |
| `input.toggle_off` | `https://<backend>/webhooks/gate-state/<token>/not-closed` |

`<token>` is `GATE_STATE_WEBHOOK_TOKEN`. Register them in the Shelly app under
the device's *Actions*, or over RPC:

```
Webhook.Create {"cid": 100, "enable": true, "event": "input.toggle_on",
                "urls": ["https://<backend>/webhooks/gate-state/<token>/closed"]}
```

`cid` is `SHELLY_INPUT_COMPONENT_ID`. Confirm the input is set to **detached**
first — otherwise it drives the relay and the gate reopens itself every time it
closes.

**The URL contains a secret.** The device cannot send custom headers, so the
token has to travel in the path. The backend rewrites it out of its own request
log; the reverse proxy needs the same treatment (see `docs/DEPLOY.md`). This
token can only report a position — it shares nothing with the trigger path and
cannot move a gate — but it is still a secret and rotating it means re-running
`Webhook.Create`.

Webhooks are fire-and-forget: no retries, no queue, no delivery guarantee. A
missed one is corrected by the reconciliation poll -- every 60 seconds, and
once 20 seconds after each pulse, which is when a lost event matters most and
when the gate has just finished travelling.

Pull-to-refresh also forces a direct read (`GET /gate/status?fresh=1`). It is
the one gesture that unambiguously means "tell me the truth now", so it is the
one that spends a Shelly request; every other caller answers from memory.
Throttled to `GATE_STATE_REFRESH_MIN_GAP_MS`, because Shelly limits per ACCOUNT
at roughly one request a second and the gate button shares that lane -- an
unbounded pull would queue requests in front of a pulse. If corrections show up in the log regularly, fix the
webhooks rather than polling faster.

### Failures

Every non-2xx body is `{ok: false, code, message}`, plus `retryAfterMs` on a
cooldown rejection.

| Code | HTTP | Meaning |
|---|---|---|
| `GATE_COOLING_DOWN` | 409 | Too soon after the last pulse. Carries `retryAfterMs` |
| `ATTEMPT_IN_PROGRESS` | 409 | That same tap is still in flight |
| `TIMEOUT_AMBIGUOUS` | 504 | Shelly did not answer. **The pulse may have fired** |
| `DEVICE_OFFLINE` | 502 | The relay is unreachable — usually Wi-Fi at the pillar |
| `DEVICE_FAILED_COMMAND` / `DEVICE_NOT_FOUND` | 502 | Shelly rejected it |
| `ACCESS_DENIED` | 403 | Not allowed, no such account, or account disabled |
| `SESSION_EXPIRED` | 401 | Token missing, expired or invalid |
| `RATE_LIMITED` | 429 | Too many requests |
| `BAD_REQUEST` | 400 | Malformed body |
| `INTERNAL` | 500 | Something failed inside |

`ACCESS_DENIED` is deliberately identical whether the account doesn't exist, is
disabled, or simply lacks a grant. Login failures are identical for an unknown
email and a wrong password, and take the same amount of time — the endpoint is
not a directory of who has an account.

Rate limits: login 10/min per IP *and* per email; trigger 20/min per user and
60/min per IP.

---

## The safety rules

Worth understanding before changing anything in `application/` or
`infrastructure/db/command-guard.ts`.

**Cooldown.** No pulse within `GATE_COOLDOWN_MS` of the last one. The claim is
written *before* Shelly is called, not after — otherwise the cooldown would be
blind for the entire duration of an in-flight request, which is exactly the
window it exists to protect.

**Pessimistic window.** The claim is written at 2× the cooldown and narrowed to
1× only when the outcome is *confirmed*. An attempt whose fate is unknown — a
timeout, or a process that died mid-request — therefore holds the **longer**
guard. Writing 1× up front and extending on timeout would invert this, giving
the case with less information a weaker guard.

**Idempotency.** The app generates one UUID per user-initiated tap and reuses
it across retries. Within 60 seconds the same key returns the original result
instead of pulsing again.

**No retries. Anywhere.** A timeout does not mean the command failed — it may
well have succeeded. Retrying risks a second pulse that stops a moving gate, so
the ambiguity is surfaced to the user instead. Do not add a retry to the
adapter, the client, or the use case.

**Auditing wraps the use case** rather than sitting inside it, so attempts that
are rejected early — unknown user, access denied — are recorded by
construction rather than by remembering to log on every branch.

---

## Deploying behind TLS

**Terminate TLS at a reverse proxy.** The Node process never handles
certificates; it refuses to boot in production unless `PUBLIC_URL` starts with
`https://`, which is the operator asserting that something in front is doing
the job.

1. Point a domain at the host.
2. Get a certificate (Caddy and Certbot both automate this).
3. Proxy to the backend on `PORT`.
4. Set `NODE_ENV=production` and `PUBLIC_URL=https://gate.example.com`.
5. Bind the backend to localhost (`HOST=127.0.0.1`) so it is only reachable
   through the proxy.
6. Run it under a process supervisor — systemd is fine — as a non-root user
   that owns the database file.

Caddy needs about this much:

```
gate.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

CORS is enabled **only** outside production, for the Expo dev client. A shipped
app is a native binary that sends no `Origin`, so production does not need it
and does not get it.

Back up `gate.db`. It holds your users, grants and audit history.

---

## Tests

```bash
npm test          # 180 backend + 4 shared
npm run typecheck # all three workspaces
```

Run these from the **root**. `npm test -w backend` alone can run against a
stale `@gate/shared` build.

Every safety-critical invariant is proven by mutation: the implementation is
deliberately broken, the test is watched failing, then reverted. A test that
has never failed has told you nothing. No test calls the real Shelly API —
each one would move a real gate.

---

## Troubleshooting

**`Invalid configuration: X, Y`** — those variables are missing or malformed in
`.env`. Note that `.env` goes in the repo root, not `backend/`.

**`PUBLIC_URL must use https:// in production`** — working as intended. Either
put a TLS proxy in front, or you are not actually in production.

**Phone can't reach the backend** — check `HOST=0.0.0.0` (not `127.0.0.1`),
that both devices are on the same network, and that the firewall is allowing
Node. `GET /gate/status` from a laptop browser on the same Wi-Fi is a quick
check.

**`Project is incompatible with this version of Expo Go`** — the app's SDK is
newer than the installed Expo Go. Either update Expo Go, or pin the app down
with `npx expo install --fix` after changing the `expo` version.

**Metro fails on a React Native internal file after an SDK change** — stale
hoisted packages. Delete `node_modules` everywhere plus `package-lock.json` and
reinstall; `npm prune` is not enough.

**`reachable: false` with a real device** — the relay has lost Wi-Fi, or
`SHELLY_DEVICE_ID` / `SHELLY_HOST` are wrong. The service reports it honestly
rather than failing the request.
