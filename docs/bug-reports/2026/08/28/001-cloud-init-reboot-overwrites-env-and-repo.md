# Bug Report: Cloud-init reboot overwrites .env and repo state

- **Severity:** HIGH — staging website unreachable after server reboot
- **Date:** 2026-08-28
- **Environment:** staging (`78.46.192.37`, `staging.openaidom.com`)
- **Discovered:** Website became unreachable. Investigation showed all containers were gone and `/opt/herobids/.env` was missing.

## Observed Behavior

After a server reboot (Hetzner maintenance or Terraform recreation), `https://staging.openaidom.com` was unreachable. SSH into the server revealed:

- Zero Docker containers running (not even exited ones)
- `/opt/herobids/.env` missing
- `/opt/herobids/.env.staging` present (created by cloud-init from `.env.example`)
- `herobids.service` systemd unit: `inactive (dead)`
- Server uptime: 13 minutes (fresh reboot)
- Cloud-init status: `done` — it had re-run on boot

## Root Cause

The `runcmd` section of `cloud-init.yaml` unconditionally runs `git clone` into `/opt/herobids`:

```yaml
- GIT_SSH_COMMAND="..." git clone --branch ${git_branch} ${git_repo_url} /opt/herobids
```

Cloud-init `runcmd` executes on **every boot** by default on Ubuntu 24.04. When the server reboots:

1. Cloud-init re-runs `runcmd`
2. `git clone` fails because `/opt/herobids` already exists (non-empty directory)
3. But the subsequent `cp -n .env.example .env.staging` runs (no-clobber, so it's a no-op if the file exists)
4. The `.env` file (uploaded by `deploy.sh` as `/opt/herobids/.env`) is not restored — it's gitignored and not in the repo
5. The `herobids.service` systemd unit tries to start `docker compose up` but fails without `.env`
6. All services are down

Even if `git clone` fails on reboot (because the directory exists), the damage is that `.env` is never re-created — it only exists because `deploy.sh` uploaded it, and that step doesn't run on reboot.

## Impact

- Staging website and API completely down after any server reboot
- Requires manual `deploy.sh` re-run to restore `.env` and restart services
- Production would have the same vulnerability once Nomad is enabled there

## Fix

1. Guard `git clone` with a directory existence check — only clone on first boot:
   ```yaml
   - |
     if [ ! -d /opt/herobids/.git ]; then
       GIT_SSH_COMMAND="..." git clone --branch ${git_branch} ${git_repo_url} /opt/herobids
     else
       logger -t cloud-init "Repo already exists at /opt/herobids — skipping clone"
     fi
   ```

2. Guard `cp -n .env.example` similarly — only on first boot.

3. Guard `git config` similarly — only on first boot (idempotent but unnecessary on reboot).

This ensures reboots are safe: the repo, `.env`, and any deployed state survive intact. The `herobids.service` systemd unit then starts the app normally on boot.

## Related

- [lessons-learnt.md](../../../infra/hetzner/docs/auto-scaling/lessons-learnt.md) — item #10
