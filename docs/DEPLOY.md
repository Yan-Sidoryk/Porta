# Deploying Porta

The backend runs on a free Oracle Cloud VM behind Caddy. This document is the
runbook for the machine that exists, and the recipe for rebuilding it if that
machine is lost.

`README.md` covers *why* the backend is shaped the way it is, and how users and
grants work once it is running. This covers only getting it onto a host.

---

## What is deployed

| | |
|---|---|
| Host | Oracle Cloud, `eu-frankfurt-1` — reserved public IP, in the console under Instances |
| Shape | `VM.Standard.E2.1.Micro` — x86_64, 2 vCPU (1/8 OCPU baseline), 1 GB RAM |
| URL | `https://porta-app.duckdns.org` |
| OS | Ubuntu 24.04 LTS |
| Runtime | Node 24 |
| TLS | Caddy 2, automatic Let's Encrypt |
| SSH | `ssh -i ~/.ssh/oracle.key ubuntu@<host-ip>` |

Ampere A1 was out of capacity at launch time, hence the AMD micro shape. It is
enough: the backend idles at roughly 100 MB and serves a few dozen requests a
day. The one place the small box is felt is `argon2id` on login, which is
memory-hard by design and takes a second or two on a burstable core. Logins are
rare; gate pulses do not hash anything.

### Layout on the host

| Path | Owner | What |
|---|---|---|
| `/opt/porta` | `ubuntu` | git checkout, so `git pull` needs no sudo |
| `/opt/porta/.env` | `porta` `600` | secrets, never in git |
| `/var/lib/porta/gate.db` | `porta` `600` | users, grants, audit log |
| `/var/lib/porta/backups/` | `porta` | nightly copies, 7-day retention |
| `/etc/systemd/system/porta.service` | root | supervision |
| `/etc/caddy/Caddyfile` | root | TLS + reverse proxy |

**The service runs as `porta`, not `ubuntu`.** `ubuntu` has passwordless sudo,
so running an internet-facing process as that user means a compromise of the
Node process is root on the machine that opens the gate. `porta` is a system
account with no shell, and the systemd unit gives it exactly one writable path.

**The database lives outside the checkout** so `git pull` can never touch it and
`ProtectSystem=strict` can keep `/opt` read-only at runtime.

---

## Redeploying a change

```bash
ssh -i ~/.ssh/oracle.key ubuntu@<host-ip>
cd /opt/porta && git pull \
  && npm ci -w shared -w backend --include-workspace-root \
  && npm run build -w shared && npm run build -w backend \
  && sudo systemctl restart porta
```

`-w shared -w backend --include-workspace-root` is not optional on a 1 GB box.
A plain `npm ci` also installs the `app` workspace — all of React Native and
Expo — which is several hundred megabytes of dependencies the server never
runs.

Confirm it came back:

```bash
systemctl is-active porta
sudo journalctl -u porta -n 20 --no-pager
```

A healthy start logs `Server listening at http://127.0.0.1:3000` followed by
`gate opener backend listening`.

---

## Operating it

### Is it alive?

```bash
curl -s -X POST https://porta-app.duckdns.org/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"..."}'
```

A `200` with tokens proves the whole chain: Caddy, TLS, Node, SQLite, argon2.

For the gate itself, use the token against `/gate/status`. It never moves the
gate:

```bash
curl -s https://porta-app.duckdns.org/gate/status -H "Authorization: Bearer $TOK"
```

`reachable: false` means the Shelly relay is offline, not that the deployment
is broken. `position: "unknown"` is always correct — there is no position
sensor, and the backend refuses to guess.

To see whether the fault is the device or the path to it, use the read-only
probe. It calls Shelly's `get` endpoint, never `set/switch`:

```bash
cd /opt/porta/backend
sudo -u porta /usr/bin/node --env-file=/opt/porta/.env dist/scripts/probe-shelly.js
```

`HTTP 200` with `"online": 0` means Shelly Cloud is fine and the relay is
unplugged or off WiFi. A timeout or network failure means the host cannot reach
Shelly Cloud.

### Adding a user

```bash
cd /opt/porta/backend
sudo -u porta /usr/bin/node --env-file=/opt/porta/.env dist/scripts/create-user.js \
  --email them@example.com --password 'their-password' --role owner
```

Run it as `porta`, or the rows land in a database file the service cannot write.
**Save the UUID it prints** — there is no endpoint that lists users.

See `README.md` for what `owner` and `user` actually permit. Short version: for
family phones use `owner`; `user` can do nothing until granted a time window.

### Changing a password

There is no route and no script for this — `SqliteUserRepository` has only
`findById`, `findByEmail` and `create`. Update the hash in place, which keeps
the user id so audit history and grants survive:

```bash
cd /opt/porta/backend
read -rs -p "New password: " PW; echo
sudo -u porta env NEW_PW="$PW" /usr/bin/node --input-type=module -e '
import Database from "better-sqlite3";
import { hashPassword } from "./dist/infrastructure/password.js";
const db = new Database("/var/lib/porta/gate.db");
const r = db.prepare("update users set password_hash=? where email=?")
            .run(await hashPassword(process.env.NEW_PW), "you@example.com");
console.log(r.changes === 1 ? "password updated" : "no such user");
'
unset PW
```

`read -rs` keeps the password off the screen and out of `ps`. Never pass it as a
literal argument on a shared machine.

### Backups

A cron job owned by `porta` runs nightly at 03:00 and keeps 7 days. View it with
`sudo crontab -u porta -l`.

`.backup` is safe against a live database. `cp` is not — it can capture a torn
write mid-transaction.

These copies live on the same volume, which does not survive losing the
tenancy. Pull one down periodically:

```bash
ssh -i ~/.ssh/oracle.key ubuntu@<host-ip> \
  'sudo cp /var/lib/porta/gate.db /tmp/gate-backup.db && sudo chown ubuntu /tmp/gate-backup.db'
scp -i ~/.ssh/oracle.key ubuntu@<host-ip>:/tmp/gate-backup.db .
```

The copy step is needed because `/var/lib/porta` is `750` and `scp` runs as
`ubuntu`.

To restore: stop the service, copy the file over `gate.db`, `chown porta:porta`,
`chmod 600`, start.

---

## Oracle-specific traps

**Idle reclamation will stop this instance.** Oracle reclaims Always Free
compute when, over a rolling 7-day window, CPU 95th-percentile and network are
both under 20%. A gate opener serving a few dozen requests a day is precisely
that profile. **Upgrade the account to Pay As You Go** — PAYG is exempt and
still costs nothing inside the Always Free limits. Set a $1 budget alert as a
tripwire.

**The free tier changes without announcement.** In June 2026 Oracle halved the
Ampere A1 allowance from 4 OCPU/24 GB to 2 OCPU/12 GB with no blog post and no
email until termination notices went out. Treat this host as replaceable and
keep the database backed up off-box.

**Ports are firewalled in two independent places.** Opening one is the single
most common way to lose an hour here. You need *both*:

1. The VCN Security List — Console → Networking → VCN → your subnet → Security
   List → Add Ingress Rules, TCP `80` and `443` from `0.0.0.0/0`.
2. The host's own iptables, which Oracle's Ubuntu images ship locked down:

```bash
sudo iptables -I INPUT 1 -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 1 -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

Diagnosis: from outside, a **timeout** means the VCN is dropping the packet; a
**connection refused** means the packet reached the host and nothing is
listening. Caddy cannot obtain a certificate until 80 is open, and both the
HTTP-01 and TLS-ALPN-01 challenges will fail in its logs until then.

**1 GB RAM needs swap.** `npm ci` and `tsc` will be OOM-killed without it:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

---

## Rebuilding from scratch

Assumes an Ubuntu 24.04 instance with a public IP, a DNS name pointing at it,
and both firewall layers open per above. Reserve the public IP in the console —
ephemeral ones change on stop/start and break DNS.

**1. Swap**, as above.

**2. Runtime.**

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs git sqlite3
```

**3. Service account.**

```bash
sudo useradd --system --home /var/lib/porta --shell /usr/sbin/nologin porta
sudo mkdir -p /var/lib/porta/backups && sudo chown -R porta:porta /var/lib/porta
sudo chmod 750 /var/lib/porta
sudo mkdir -p /opt/porta && sudo chown ubuntu:ubuntu /opt/porta
```

**4. Source.** The repo is private, so generate a deploy key and add its public
half at GitHub → repo → Settings → Deploy keys, read-only:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/github_deploy -N ''
printf 'Host github.com\n  IdentityFile ~/.ssh/github_deploy\n  IdentitiesOnly yes\n' > ~/.ssh/config
chmod 600 ~/.ssh/config
cat ~/.ssh/github_deploy.pub
git clone git@github.com:Yan-Sidoryk/Automatic-Door-app.git /opt/porta
```

**5. Build.**

```bash
cd /opt/porta
npm ci -w shared -w backend --include-workspace-root
npm run build -w shared && npm run build -w backend
```

**6. Configuration.** Create `/opt/porta/.env`. Copy `SHELLY_*` from a trusted
existing environment; generate a **fresh** `JWT_SECRET` with
`openssl rand -base64 48` rather than reusing a development one.

```bash
SHELLY_HOST=shelly-XXX-eu.shelly.cloud
SHELLY_AUTH_KEY=...
SHELLY_DEVICE_ID=...
JWT_SECRET=...
GATE_COOLDOWN_MS=5000
DATABASE_PATH=/var/lib/porta/gate.db
PUBLIC_URL=https://porta-app.duckdns.org
NODE_ENV=production
PORT=3000
HOST=127.0.0.1
```

```bash
sudo chown porta:porta /opt/porta/.env && sudo chmod 600 /opt/porta/.env
```

`HOST=127.0.0.1` binds to loopback so the only route in is through Caddy.
`PUBLIC_URL` must be `https://` — `config.ts` refuses to boot otherwise, and
that refusal is the operator asserting a proxy is terminating TLS.

**7. First user**, per *Adding a user* above.

**8. systemd.** Write `/etc/systemd/system/porta.service`:

```ini
[Unit]
Description=Porta gate opener backend
After=network-online.target
Wants=network-online.target

[Service]
User=porta
Group=porta
WorkingDirectory=/opt/porta/backend
ExecStart=/usr/bin/node --env-file=/opt/porta/.env dist/server.js
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/porta

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now porta
```

**9. Caddy.**

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

`/etc/caddy/Caddyfile`:

```
porta-app.duckdns.org {
    reverse_proxy 127.0.0.1:3000
}
```

`sudo systemctl restart caddy`, then watch `sudo journalctl -u caddy -f` for
`certificate obtained successfully`.

**10. Backup cron.** As `sudo crontab -u porta -e`:

```
0 3 * * * sqlite3 /var/lib/porta/gate.db ".backup '/var/lib/porta/backups/gate-$(date +\%F).db'" && find /var/lib/porta/backups -name 'gate-*.db' -mtime +7 -delete
```

---

## The app

`app/eas.json` supplies `GATE_API_URL` to standalone builds, because a built
APK has no Metro server to infer a host from:

```json
"env": { "GATE_API_URL": "https://porta-app.duckdns.org" }
```

Commit that before `eas build -p android --profile preview`, or the build will
not see it. In development the value stays unset and `api.ts` falls back to
Metro's `hostUri`, which follows the dev machine across DHCP leases.

CORS is enabled **only** outside production. A shipped app is a native binary
that sends no `Origin`, so production neither needs it nor gets it.
