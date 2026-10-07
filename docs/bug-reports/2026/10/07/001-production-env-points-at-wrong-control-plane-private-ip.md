# Bug: production worker cannot reach Nomad because `.env.production` uses `10.1.0.2`, but the control plane is `10.0.0.2`

**Date:** 2026-10-07
**Severity:** HIGH. The production worker can't call the Nomad API, so no agent can launch in production. Agents launched later would also get the wrong Redis and Postgres host. Impact is limited for now because production is pre-launch (only operator test accounts exist).
**Status:** OPEN. Fix described below; nothing has been changed yet.
**Fix location:** herobids `infra/hetzner/` (env file, `production.tfvars`, `deploy.sh`) plus infra docs. No application code changes.

## How to use this report

This report is self-contained. Work from the herobids repo root. Follow `AGENTS.md`. The
real `.env*` files are gitignored; only their `.example` twins are committed. Do not commit
or push unless the user asks. Production was provisioned for the first time on
2026-10-07 and holds no real user data.

## Summary

`infra/hetzner/.env.production` contains:

```
NOMAD_ADDR=http://10.1.0.2:4646
SHARED_REDIS_HOST=10.1.0.2
SHARED_POSTGRES_HOST=10.1.0.2
```

The production control plane's private IP is `10.0.0.2`, not `10.1.0.2`. The production
Hetzner network is `10.0.0.0/16`, not `10.1.0.0/16`.

## Evidence (captured 2026-10-07)

1. The `provision.sh --env production` output from the first production provision:
   ```
   control_plane_private_ip = "10.0.0.2"
   nomad_server_addr        = "http://10.0.0.2:4646"
   private_network_ip_range = "10.0.0.0/16"
   private_subnet_ip_range  = "10.0.0.0/24"
   agent_node_private_ips   = ["10.0.0.3"]
   ```
2. On the production control plane (`167.233.213.107`):
   ```sh
   ssh -i ~/.ssh/herobids_deploy_key_prod root@167.233.213.107 '
     grep -E "^(NOMAD_ADDR|SHARED_REDIS_HOST|SHARED_POSTGRES_HOST)=" /opt/herobids/.env
     ip -4 addr show enp7s0 | grep inet
     docker exec herobids-worker-1 sh -c "wget -qO- --timeout=5 http://10.1.0.2:4646/v1/status/leader"'
   ```
   Output: the env file holds the three `10.1.0.2` values above. `enp7s0` is
   `inet 10.0.0.2/32`. The `wget` prints `download timed out`.
3. The worker logs show this every 60 seconds:
   ```
   "name":"agent-runtime-launcher","error":{"code":"runtime.reconcile_failed","message":"This operation was aborted"},"msg":"Port reconcile failed, trying legacy path"
   ```
4. The Hetzner API (`GET /v1/networks`) shows `herobids-production-net 10.0.0.0/16` and
   `herobids-staging-net 10.0.0.0/16`. Both networks use the same range, and Hetzner accepts
   that.

## Root cause

1. **`production.tfvars` never set the network range.** These lines are commented out:
   ```hcl
   # network_ip_range = "10.1.0.0/16"
   # subnet_ip_range  = "10.1.0.0/24"
   ```
   So the defaults in `variables.tf` apply: `10.0.0.0/16` and `10.0.0.0/24`.
2. **The docs describe the intent, not the actual state.** All of these say production uses
   `10.1.0.0/16` / `10.1.0.2`:
   - `infra/hetzner/README.md`, the "Private Network" table (~line 311)
   - comments in `production.tfvars` and `staging.tfvars` (~line 61)
   - `infra/hetzner/environment.tfvars.example` (~line 57)
   - `infra/hetzner/terraform.tfvars.example` (~line 69)
   - `infra/hetzner/docs/runbooks/production-notes.md` §1
   - `infra/hetzner/docs/auto-scaling/setup-auto-scaling.md` Step 3
   - `infra/hetzner/docs/runbooks/reprovision-runbook.md` steps 4, 6a and 10

   The operator filled in `.env.production` from those docs. This was reinforced by an AI
   assistant's answer on 2026-10-07 that repeated the docs instead of checking
   `terraform output`.
3. **Nothing checks the env file against Terraform.** `deploy.sh` and `setup-nomad.sh`
   upload `.env.<env>` as-is. A wrong private IP only shows up at runtime, as a Nomad
   timeout.

### What is NOT the cause

- **The firewall.** Worker → Nomad is allowed by the UFW rules from `172.18.0.0/16` to
  4646–4648 (see `cloud-init.yaml`). The request times out because nothing listens at
  `10.1.0.2`.
- **Nomad health.** Nomad runs on `10.0.0.2`.
- **The "overlapping networks" warning.** The README says staging and production networks
  "MUST NOT overlap". Hetzner allows two separate networks in one project to share a range,
  and both currently do. The overlap only matters if the networks are ever connected, and
  nothing in this repo connects them.

## Fix

### Decision: keep production on `10.0.0.0/16` (recommended)

Make the files describe what is actually provisioned. Don't renumber.

Renumbering production to `10.1.0.0/16` would replace `hcloud_network.private`, which
cascades to the control-plane attachment and the agents. The control plane's UFW rules
(`ufw allow from ${private_subnet} ...` in `cloud-init.yaml`) were set at first boot, and
`hcloud_server.default` has `lifecycle { ignore_changes = [user_data] }`. Those rules would
stay pinned to `10.0.0.0/24` and block the renumbered agents unless someone edits them by
hand or rebuilds the control plane. That only makes sense as part of a full rebuild.

### Step 1: correct `.env.production`

Edit `infra/hetzner/.env.production` (gitignored; never print secret values):

```
NOMAD_ADDR=http://10.0.0.2:4646
SHARED_REDIS_HOST=10.0.0.2
SHARED_POSTGRES_HOST=10.0.0.2
```

Get the authoritative value from Terraform rather than assuming:

```sh
cd infra/hetzner
terraform workspace select production
terraform output -raw control_plane_private_ip   # expect 10.0.0.2
```

(Backend init needs `.env.backend`; `scripts/provision.sh` does it for you. If `terraform`
complains about the backend, run the `terraform_output` helper from
`scripts/_ssh_opts.sh` instead.)

### Step 2: deploy the env file and recreate the containers that read it

Fastest route, without a full deploy:

```sh
infra/hetzner/scripts/setup-env.sh --env production 167.233.213.107 --file infra/hetzner/.env.production
ssh -i ~/.ssh/herobids_deploy_key_prod root@167.233.213.107 \
  'cd /opt/herobids && docker compose -f docker-compose.yaml -f docker-compose.prod.yaml up -d --force-recreate worker api'
```

Or run a full deploy (it waits for the CI image build):
`infra/hetzner/deploy.sh --env production 167.233.213.107 --env-file infra/hetzner/.env.production`.

### Step 3: verify

```sh
ssh -i ~/.ssh/herobids_deploy_key_prod root@167.233.213.107 '
  docker exec herobids-worker-1 sh -c "wget -qO- --timeout=5 http://10.0.0.2:4646/v1/status/leader"; echo
  sleep 70; docker logs herobids-worker-1 --since 70s 2>&1 | grep -c "runtime.reconcile_failed"'
```

Expected: the leader address (`"10.0.0.2:4647"`), then a count of `0`.

### Step 4: make `production.tfvars` state its network explicitly

In `infra/hetzner/production.tfvars`, replace the commented block with explicit values
that match the current state, and fix the comment:

```hcl
# ── Private Network ───────────────────────────────────────
# Production uses 10.0.0.0/16, the same range as staging. They are separate
# Hetzner networks that are never connected, so the overlap is harmless.
# The control plane's private IP is Hetzner-assigned (normally .2). Always
# read it with `terraform output -raw control_plane_private_ip`.
network_ip_range = "10.0.0.0/16"
subnet_ip_range  = "10.0.0.0/24"
```

Then confirm this is a no-op: `infra/hetzner/scripts/provision.sh --env production --var-file infra/hetzner/production.tfvars`
must show **no changes**. Answer `N` at the apply prompt if it shows anything else, and
investigate.

Do the same in `staging.tfvars`: drop the "do NOT overlap with production's 10.1.0.0/16"
comment. Staging's values are already the defaults.

### Step 5: add a fail-fast guard in `deploy.sh`

So this can't recur, `infra/hetzner/deploy.sh` should refuse to upload an env file whose
Nomad, Redis or Postgres host doesn't match Terraform. Put the check right after the
environment and server IP are resolved, before "Step 1/5: Upload .env":

```bash
# ─── Guard: env-file private IPs must match Terraform ──────────────────────
check_private_ip_vars() {
  local nomad_enabled cp_ip var value host
  nomad_enabled="$(terraform_output -raw nomad_enabled 2>/dev/null || echo "")"
  [[ "${nomad_enabled}" == "true" ]] || return 0
  cp_ip="$(terraform_output -raw control_plane_private_ip 2>/dev/null || echo "")"
  if [[ -z "${cp_ip}" ]]; then
    echo "WARNING: could not read control_plane_private_ip from Terraform; skipping private-IP check." >&2
    return 0
  fi
  for var in NOMAD_ADDR SHARED_REDIS_HOST SHARED_POSTGRES_HOST; do
    value="$(grep -E "^${var}=" "${ENV_FILE}" | tail -1 | cut -d= -f2- | sed -E 's/[[:space:]]+#.*$//')"
    host="$(printf '%s' "${value}" | sed -E 's#^[a-z]+://##; s#[:/].*$##')"
    if [[ -n "${host}" && "${host}" != "${cp_ip}" ]]; then
      echo "ERROR: ${var} in ${ENV_FILE} points at ${host}, but the ${HEROBIDS_ENV} control-plane private IP is ${cp_ip}." >&2
      echo "       Fix ${ENV_FILE} (see docs/bug-reports/2026/10/07/001-...)." >&2
      exit 1
    fi
  done
}
check_private_ip_vars
```

Rules:
- Match the existing variable names in `deploy.sh` (`ENV_FILE`, `HEROBIDS_ENV`, and the
  `terraform_output` helper from `scripts/_ssh_opts.sh`). Read the script first.
- Skip the check, with a warning, when Terraform can't be read (e.g. no backend creds). That
  is warn-and-continue, not fatal.
- Fail hard on a confirmed mismatch.
- `setup-nomad.sh` calls `deploy.sh`, so it inherits the guard. Don't duplicate it.
- If there's a shell test harness for `deploy.sh` under `infra/hetzner/scripts/tests/`,
  add a test there. Otherwise, verify manually: put a wrong `NOMAD_ADDR` in a temporary
  copy of the env file and confirm `deploy.sh --env production <ip> --env-file <copy>`
  exits 1 before uploading anything. Delete the copy afterwards.

Also add a one-line hint above the three variables in `infra/hetzner/.env.environment.example`:

```
# Must equal `terraform output -raw control_plane_private_ip` for this env (deploy.sh checks this).
```

### Step 6: correct the docs

Replace the production `10.1.x` claims with the real values, and soften "MUST NOT overlap"
to the accurate statement above:

| File | Change |
|---|---|
| `infra/hetzner/README.md` (Private Network table + warning) | Production `10.0.0.0/16` / `10.0.0.0/24`. Replace the warning with: "Separate Hetzner networks may share a range; they are never connected. Read the control-plane IP from `terraform output`, never from this table." |
| `infra/hetzner/docs/runbooks/production-notes.md` §1 | Production row → `10.0.0.0/16`, `10.0.0.0/24`, `10.0.0.2`, `10.0.0.3`. Keep the "confirm with `ip -4 addr show enp7s0`" advice and point to the `deploy.sh` guard. |
| `infra/hetzner/docs/auto-scaling/setup-auto-scaling.md` Step 3 | "defaults to `10.0.0.2`… staging and production use non-overlapping…" → "read it from `terraform output -raw control_plane_private_ip`" |
| `infra/hetzner/docs/runbooks/reprovision-runbook.md` steps 4, 6a, 10 | Remove the "production: `10.1.0.x`" variants and use `<control-plane-private-ip>` / `<agent-private-ip>` from `terraform output`. |
| `infra/hetzner/environment.tfvars.example`, `terraform.tfvars.example` | Remove "Production: use 10.1.0.0/16". |
| `infra/hetzner/docs/auto-scaling/lessons-learnt.md` | Add a new numbered entry: "Docs said production was `10.1.0.0/16`; Terraform defaults made it `10.0.0.0/16`; env file followed the docs." Fix: explicit tfvars + `deploy.sh` guard. Lessons #1 and #11 talk about the `10.1` prefix generically; leave them as is. |

## Acceptance checklist

- [ ] The worker reaches Nomad: `wget .../v1/status/leader` from `herobids-worker-1` returns the leader.
- [ ] No `runtime.reconcile_failed` in worker logs for 2 minutes after the restart.
- [ ] `provision.sh --env production` plan shows no changes after the `production.tfvars` edit.
- [ ] `deploy.sh` exits 1 when given an env file with a wrong `NOMAD_ADDR`, and passes with the corrected file.
- [ ] No doc under `infra/hetzner/` still claims production is `10.1.0.0/16`: `grep -rn "10\.1\.0" infra/hetzner --include=*.md --include=*.tfvars* --include=*.example` (only lessons #1 and #11 should match).
- [ ] An agent started in production reaches `running` with no `Stale agent start detected`. This also needs a ready agent node and a reachable Traderton boundary for trading agents. A non-trading agent is enough to verify this fix.

## Related

- `docs/features/2026/10/07/001-private-agent-nodes/001-plan.md`: the Hetzner Primary IP
  quota fix. It changes agent networking, and its validation needs this bug fixed first.
