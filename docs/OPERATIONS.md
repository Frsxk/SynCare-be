# SynCare Console: Operations Runbook

Public URL: <https://syncare.trackover.web.id>

> This backend serves **only** `/api/*`. There is no HTML at `/`; the
> frontend is a separate application (SynCare-fe) that consumes these routes.
> Every `/api` route, including `/api/health`, requires
> `Authorization: Bearer <token>`.
Backend: Elysia on Bun, thin proxy over Langflow. Langflow owns all clinical logic.

Private material setup, Linux key provisioning, demo seeding, and the explicit
protection CLI are documented in [cross-platform-secrets.md](cross-platform-secrets.md).

---

## systemd unit name

**`syncare-console.service`** (a *user* unit, no `sudo` needed).

```bash
systemctl --user status  syncare-console.service   # is it up?
systemctl --user stop    syncare-console.service   # turn it OFF (stops serving the domain)
systemctl --user start   syncare-console.service   # turn it back on
systemctl --user restart syncare-console.service   # reload .env after editing it
systemctl --user disable syncare-console.service   # stop it starting at boot too
systemctl --user enable  syncare-console.service   # start at boot again
```

`disable` is the one you want "if I don't need it anymore": it unhooks it from
`default.target`, so it will not come back after a reboot.

View its logs:

```bash
journalctl --user -u syncare-console.service -f          # follow
journalctl --user -u syncare-console.service --since -10m  # recent
```

**Turning it off does not stop Langflow.** Langflow is the separate
`syncare-langflow` Docker container. If you want the whole stack down:

```bash
cd ~/kittys-workspace/syncare-be && docker compose stop langflow
```

With the console stopped, `https://syncare.trackover.web.id` returns **502**;
Caddy is still up and serving other domains (notably `hermes.frxkie.me`).

---

## Turning off just the public exposure

The unit binds `127.0.0.1:8080` only, so the port is never public by itself.
To take the domain offline while leaving the console running locally, comment
out the `syncare.trackover.web.id { ... }` block in `/etc/caddy/Caddyfile`:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && sudo systemctl reload caddy
```

Backups live at `/etc/caddy/Caddyfile.bak-*`.

---

## Rotating the API token

The bearer token is read from `.env` **at startup only**.

```bash
cd ~/kittys-workspace/syncare-be
python3 -c "import secrets; print(secrets.token_urlsafe(32))"   # generate
# edit SYNCARE_API_KEY= in .env  (chmod 600), then:
systemctl --user restart syncare-console.service
```

Verify: an unauthenticated call must be `401`, an authenticated one `200`.

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://syncare.trackover.web.id/api/v1/plans   # 401
set -a; . ./.env; set +a
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $SYNCARE_API_KEY" \
  https://syncare.trackover.web.id/api/v1/plans                                          # 200
```

---

## Health and status

| Check | Command | Healthy |
|---|---|---|
| Console | `curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $SYNCARE_API_KEY" http://127.0.0.1:8080/api/health` | `200` |
| Langflow | `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7860/health` | `200` |
| Public API rejects anonymous | `curl -s -o /dev/null -w '%{http_code}' https://syncare.trackover.web.id/api/v1/plans` | `401` |
| Port binding | `ss -ltn \| grep :8080` | `127.0.0.1:8080` only |
| Restart loop | `systemctl --user show syncare-console.service -p NRestarts` | not climbing |

`/api/health` requires the bearer token like every other route (the console
serves only the API; `/` is a plain 404). It returns liveness and manifest
status, and no patient data.

---

## Read-only mode

For a demo where nobody may approve a plan, stop the unit and restart it with
read-only mode. Writes return `403`; reads and F1-F3 still work.

```bash
systemctl --user stop syncare-console.service
SYNCARE_READ_ONLY=1 systemd-run --user --unit=syncare-console-ro \
  --property=WorkingDirectory=/home/ubuntu/kittys-workspace/syncare-be \
  --property=EnvironmentFile=/home/ubuntu/kittys-workspace/syncare-be/.env \
  /home/ubuntu/.bun/bin/bun /home/ubuntu/kittys-workspace/syncare-be/src/index.ts
```

Simplest alternative: add `SYNCARE_READ_ONLY=1` to `.env` and restart the unit.
Note this also disables the live approval click, so F4 demo becomes Langflow-UI-only.

Read-only startup does **not** repair F1 assessments orphaned in `RUNNING` by a
crash. A controlled, authorized restart in writable mode is required for the
one-shot audited `RUNNING` → `UNKNOWN` transition (`assessment.recovered_unknown`).
Recovery never replays F1; request a fresh assessment explicitly afterward.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `502` from the domain | console unit stopped, or crashed on boot | `systemctl --user status syncare-console.service`, then read the journal |
| `503 auth_not_configured` | `SYNCARE_API_KEY` missing or empty in `.env` | set it, then restart the unit |
| `401` with a valid token | token rotated but unit not restarted | `systemctl --user restart syncare-console.service` |
| `502 events_unavailable` | the Langflow job id is unknown or already finished | expected for a stale id; start a new F4 job |
| SSE arrives all at once | proxy buffering | `flush_interval -1` is already set in the vhost |
| Cert expired / not issued | ACME could not reach the host | check `journalctl -u caddy`; confirm DNS points at `129.226.201.207` |
| Langflow unhealthy after edits | custom component code is cached in the container | `docker compose up -d --force-recreate langflow` (a plain `restart` re-reads nothing) |

---

## Network shape

```
Internet ──NAT──▶ 10.3.8.40 (eth0)  ──Caddy :443──▶ 127.0.0.1:8080 (console)
                                                 └──▶ 127.0.0.1:7860 (Langflow, container)
```

Public `129.226.201.207` is NATed to `10.3.8.40`. Caddy binds the LAN IP only,
leaving `100.89.55.94:443` (tailscaled) alone. The console binds loopback, so
the only way in is through Caddy.
