# Production Notes

**Status:** living reference
**Date:** 2026-10-07

This is not a full runbook — see `reprovision-runbook.md` for that. This page
collects the places where **production genuinely behaves differently from
staging**, not just different config values. Read this before running any
staging-oriented doc or script against production for the first time.

---

## 1. Private network and control-plane IP

Staging and production currently use the **same** `/16` private network range.
They are separate Hetzner networks that are never connected, so the shared
range is harmless:

| Environment | Network CIDR | Subnet CIDR | Control-plane private IP | Agent-1 private IP |
|---|---|---|---|---|
| Staging | `10.0.0.0/16` | `10.0.0.0/24` | `10.0.0.2` | `10.0.0.3` |
| Production | `10.0.0.0/16` | `10.0.0.0/24` | `10.0.0.2` | `10.0.0.3` |

The control-plane's private IP is Hetzner-auto-assigned (no explicit `ip =` in
`main.tf`'s `hcloud_server_network.control_plane` resource) — `.1` is the
subnet gateway, `.2` goes to the first attached server. This is convention,
not something pinned in Terraform; **confirm the actual IP after provisioning**
rather than assuming it:

```sh
terraform output -raw control_plane_private_ip   # authoritative
ssh root@<production-ip> 'ip -4 addr show enp7s0' # cross-check on the box
```

`NOMAD_ADDR`, `SHARED_REDIS_HOST`, `SHARED_POSTGRES_HOST` in `.env.production`
are static strings that must match whatever Hetzner actually assigned — they
do not update themselves on re-provision. `deploy.sh` now refuses to upload an
env file whose private-IP hosts don't match `terraform output`, so a stale
value fails fast at deploy time instead of silently timing out against Nomad.

## 2. SSH deploy keys differ by environment

Staging and production use **different** SSH deploy keys:

| Environment | `ssh_public_key_path` (in `<env>.tfvars`) | Private key |
|---|---|---|
| Staging | `~/.ssh/herobids_deploy_key.pub` | `~/.ssh/herobids_deploy_key` |
| Production | `~/.ssh/herobids_deploy_key_prod.pub` | `~/.ssh/herobids_deploy_key_prod` |

**Historical bug (fixed 2026-10-07):** `scripts/_ssh_opts.sh`'s
`resolve_ssh_key()` used to check the generic `terraform.tfvars` *before*
`${HEROBIDS_ENV}.tfvars`. Since a `terraform.tfvars` with the staging key
exists in this repo, every script that relied on auto-detection
(`reset.sh`, `reset-and-run.sh`, `setup-nomad.sh`, etc.) silently used the
**staging** key for production commands. It happened to work when the
staging key was also authorized on the production server (both deploy keys
may be added to the same GitHub repo), masking the bug — but any script that
needed to resolve `HEROBIDS_SSH_KEY` for a *different* purpose (uploading the
right `tfvars`, matching `destroy.sh`'s expectations, etc.) was at risk.
Fixed by checking `${HEROBIDS_ENV}.tfvars` first. If you ever see a script
using an unexpected key, `source scripts/_ssh_opts.sh && parse_env_flag --env
<env>` and check `$HEROBIDS_SSH_KEY` directly before debugging further. See
`../auto-scaling/lessons-learnt.md` for the full writeup.

## 3. Scaling floor — production never scales to zero

| Setting | Staging | Production |
|---|---|---|
| `min_agent_nodes` | `0` (allowed to drain to zero) | `1` (never scale to zero) |
| `max_agent_nodes` | `3`–`5` | `9` |
| `agent_memory_reservation_mb` | `256` | `512` (accounts for pro-tier agent mix) |
| `scale_out_cooldown_seconds` | `120` (fast validation) | `300` (avoid cost flapping) |
| `scale_out_memory_threshold_pct` | `20`–`30` | `40` (more headroom for real users) |
| `scale_in_drain_deadline_seconds` | `600` | `900` (prod agents may take longer to drain) |
| `placement_failure_threshold` | `5` | `3` (more sensitive) |
| `placement_failure_cooldown_seconds` | `600` | `900` |
| `backups` (Hetzner automated server backups) | not set (off) | `true` |

Do not apply `-var="agent_node_count=0"` or set `min_agent_nodes=0` against
production — see `production.tfvars` for the authoritative values.

## 4. Destructive scripts have an extra confirmation gate

`reset.sh` and `reset-and-run.sh` prompt for confirmation on every
environment, but `reset-and-run.sh`'s second prompt requires typing the exact
phrase `I agree to delete active deployment` — this is deliberate friction,
not a bug, and it exists specifically because this script is just as
reachable against production as against staging and wipes Postgres + Redis
unconditionally. Treat a prompt like this as a hard stop: confirm you actually
want to destroy the target environment's data before typing the phrase, and
double check `$HEROBIDS_ENV`/the `--env` flag you passed.

There is no staging-only "safe mode" — the only thing distinguishing a
staging run from a production run is which `--env` flag and `--env-file` you
pass. Get a visual confirmation of the target (`echo $HEROBIDS_ENV`, check the
printed "Server:"/"Environment:" lines in the script's own banner) before
answering either prompt.

## 5. Traderton production dependency (critical — read before provisioning)

**As of 2026-10-07, Traderton has no production deployment.** `api.traderton.com`
has no DNS record at all (confirmed via `dig`, both from a production herobids
host and independently). Traderton's own `infra/hetzner/` only has
`staging.tfvars` — no `production.tfvars`, no production server, no production
DNS, anywhere in that repo.

This matters because:
- `setup.md` Phase 0 lists `https://api.traderton.com/health/ready` as one of
  two acceptable preconditions to check — **do not treat that as evidence it
  exists**. Always verify with `dig +short api.traderton.com` and `curl
  --max-time 10 https://api.traderton.com/health/ready` before relying on it.
- Herobids production (`.env.production`'s `TRADERTON_BOUNDARY_URL=https://api.traderton.com`)
  will start up fine, pass its own `/health` check, and run migrations
  successfully even with Traderton production absent — the core herobids
  stack has no hard dependency on Traderton at boot.
- The dependency surfaces specifically when provisioning **venue
  connections**: `quick-setup-remote.sh` (run as part of `reset-and-run.sh`
  step 2) calls `provision_venue_account` on the Traderton boundary, which
  fails with a `transport_error` → HTTP `503` after 3 retries if the boundary
  is unreachable. This is a connectivity failure, not an application bug —
  check `docker compose logs api | grep traderton` for
  `"outcome":"transport_error"` to confirm before assuming herobids broke.
- **Do not treat a `reset-and-run.sh` step-2 failure as a herobids outage.**
  Verify the core stack is actually up first (`curl .../health` → 200, `docker
  ps` shows all containers healthy) — that part is independent of Traderton
  and typically already succeeded by the time step 2 fails.

Before standing up Traderton production, decide and record: its own Hetzner
server/DNS (`api.traderton.com` → A record), and HMAC boundary credentials
that herobids's `.env.production` (`TRADERTON_BOUNDARY_HMAC_SECRET`,
`TRADERTON_BOUNDARY_CONSUMER_ID`, `TRADERTON_BOUNDARY_KEY_ID`) must match.

## 6. Reprovisioning onto a non-empty database

Unlike a from-scratch staging setup, production reprovisioning may hit a
database that already has migration history from a prior deploy attempt. If
`migrate` fails with no readable error (drizzle-kit's progress spinner
swallows stderr — `docker logs` and `docker compose run --rm migrate` both
hide the real cause behind `[⣷] applying migrations...`), don't assume the
migration file itself is broken:

1. Check how far migrations actually got:
   ```sh
   docker compose exec -T postgres psql -U herobids -d herobids \
     -c "select id, hash, created_at from drizzle.__drizzle_migrations order by created_at desc limit 15;"
   ```
2. Compare against the migration files in `packages/db/drizzle/` — if the DB
   is missing recent migrations, read the first unapplied one; destructive
   backfills (`UPDATE ... SET ... NOT NULL`, unique index creation) are the
   most likely to fail against real/stale data, additive `ALTER TABLE ADD
   COLUMN` statements are not.
3. If the data in that database isn't worth preserving (verify with the
   `users`/`agents`/`connections` tables — see step 4 below), the fastest fix
   is `reset-and-run.sh`, which runs the exact same migrations against an
   empty database. If migrations succeed cleanly there, the original failure
   was data-dependent, not a migration bug.
4. **Before wiping, check for real users.** `select id, email, is_admin,
   created_at from users;` — if any account wasn't created by your own
   seed/setup scripts (check `created_at` against known script-run
   timestamps, and whether `is_admin` accounts match your `.env.ops.<env>`
   `ADMIN_EMAIL`), stop and get explicit confirmation before running any
   destructive script. See `../runbooks/reprovision-runbook.md` step 8.
