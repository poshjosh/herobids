# Staging Recovery Diagnostic Plan

**Status:** plan — read-only investigation only. No infrastructure mutation is authorized by this document.
**Date:** 2026-09-24
**Parent:** [Staging-First External Backend Roadmap](./001-staging-first-external-backend-roadmap.md) Phase 1, step 1
**Environment:** Herobids staging (`herobids-staging`, `staging.openaidom.com`)

## Purpose

Staging is currently offline. Before provisioning Traderton or changing any
configuration, determine what is actually broken and restore the known Herobids
staging baseline. This plan is **diagnostic and read-only**: every step only
observes state. Any fix, apply, redeploy, reset, or destruction is a separate
action gated behind explicit operator approval.

## Non-Goals

- Do not provision Traderton yet.
- Do not change Herobids configuration, secrets, firewall, DNS, or compose state.
- Do not run Terraform apply/destroy, `push.sh`, `reset.sh`, or migrations.
- Do not infer that "staging offline" means the server is down — the failure
  could be DNS, TLS, Docker, the app process, or a network path. Distinguish
  them.

## Known Environment Facts (from repo, to be confirmed by observation)

- Terraform state: S3 remote backend; staging workspace and state key
  `herobids/staging/terraform.tfstate`. The backend key is set at `terraform
  init` time (see Pass 1) — `terraform workspace select` alone does NOT select
  the environment, and the `_ssh_opts.sh` helpers default to `production`.
  Always initialize the backend against the staging key in an isolated
  `TF_DATA_DIR` and assert `terraform output -raw environment` == `staging`
  before trusting any resource.
- Server name: `herobids-staging`; app domain `staging.openaidom.com`.
- Compose overlay: `docker-compose.staging.yaml`; `NODE_ENV=staging`.
- Services: `caddy` (TLS, 80/443), `api` (3000), `web` (nginx), `worker`,
  `postgres` (internal), `redis` (internal), `migrate` (one-shot), plus
  `docker-proxy` and `skills-api`.
- Deploy scripts (`infra/hetzner/scripts/`) provide `_ssh_opts.sh`,
  `provision.sh`, `smoke-test.sh`, `logs.sh`, `push.sh`, `reset.sh`, and
  `deploy.sh`, all honouring `--env staging`.

## Baseline — definition of "known-healthy"

"Known Herobids staging baseline" means the following, all concurrently true
and confirmed by observation (not assumption):

- `migrate` one-shot has completed successfully against the staging Postgres.
- All expected services are present and healthy/running (not restarting or
  crash-looping): `caddy`, `api`, `web`, `worker`, `postgres`, `redis`,
  `docker-proxy`, `skills-api`.
- The public `https://staging.openaidom.com/health` returns 2xx and Caddy is
  serving a valid (non-expired) TLS certificate for the domain.
- The API `/health` returns 2xx from inside the host as well as publicly.
- The A/AAAA record for `staging.openaidom.com` matches the Terraform
  `server_ipv4`.

A diagnosis is "complete" when it names which of these are unmet and why; a
remediation is "done" when all of them hold again.

## Investigation Passes

Run in order; each pass is read-only. A single staging outage can have multiple
concurrent causes (e.g. DNS AND a crash-looping container), so do not stop at
the first apparent cause — complete the passes needed to separate the primary
cause from secondary symptoms. Confirm any causal hypothesis with observed
evidence before acting, and require explicit approval before proceeding to any
fix.

### Pass 1 — Terraform state and server lifecycle (local, observe only)

1. Confirm Terraform and the S3 backend credentials are available locally:
   `TF_BACKEND_BUCKET`, `TF_BACKEND_REGION`, `AWS_ACCESS_KEY_ID`,
   `AWS_SECRET_ACCESS_KEY`, and (optionally) `TF_BACKEND_DYNAMODB_TABLE`.
   Confirm the ignored `infra/hetzner/staging.tfvars` exists and supplies the
   required Hetzner/provider and deployment inputs. Do not print its values.
2. Isolate state so this inspection can never read or write another
   environment. Use a throwaway data dir and initialize the backend pointed
   **explicitly at the staging key** — the backend key is set at `init` time,
   NOT by `terraform workspace select`:

   ```bash
   cd infra/hetzner
   export TF_DATA_DIR="$(mktemp -d)"
   trap 'rm -rf "$TF_DATA_DIR"' EXIT
   terraform init -input=false \
     -backend-config="bucket=${TF_BACKEND_BUCKET}" \
     -backend-config="key=herobids/staging/terraform.tfstate" \
     -backend-config="region=${TF_BACKEND_REGION}"
   terraform workspace select staging
   ```

   If the `staging` workspace does not exist, stop and report it. Do **not**
   run `terraform workspace new`: creating a workspace writes backend state
   and is not authorized by this read-only plan.

3. Assert you are looking at the right environment before trusting any
   resource: `terraform output -raw environment` MUST print `staging`, and
   `terraform output -raw server_ipv4` is the expected server IP. (Do not rely
   on the `terraform_output` helper in `_ssh_opts.sh` here — it defaults
   `HEROBIDS_ENV` to `production` and does not re-initialize the backend, so it
   can report the wrong environment.)
4. Enumerate resources with `terraform state list`. Note that `state list`
   reads **recorded** state only; it cannot see provider-side drift or a server
   destroyed outside Terraform. Detect drift or absence with this
   provider-side read, which does not save a plan or persist refreshed state:

   ```bash
   terraform plan -refresh-only -input=false -lock=false \
     -var-file=staging.tfvars
   ```

   The staging var file is mandatory: without it, required inputs are missing
   and `var.environment` defaults to `production`. An equivalent read-only
   Hetzner Cloud API query is acceptable when Terraform provider access is not
   available.
5. Note any missing resources, drift, or a state that implies the server was
   destroyed.

**Approval gate:** if state shows the server missing/destroyed, do not recreate.
Report and await a decision on re-provisioning.

### Pass 2 — DNS and public reachability (observe only)

1. Resolve `staging.openaidom.com` (A/AAAA) and compare to the Terraform server IP.
2. Test `https://staging.openaidom.com/health` (and `/health` on the API) with a
   short timeout; record the failure mode:
   - DNS resolution failure → record the resolver output.
   - TLS handshake failure → record cert errors (expired / not provisioned / Caddy down).
   - HTTP 5xx / timeout → point to the app or Caddy/upstream.
3. Note: earlier in this work, the local machine's resolver itself timed out on
   unrelated lookups, so confirm the local resolver works (e.g. resolve an
   unrelated public host) before attributing failure to staging DNS.

### Pass 3 — SSH and host state (observe only, if IP known)

1. `ssh root@<server-ip> 'echo ok'` using `scripts/_ssh_opts.sh` conventions.
2. If reachable, observe only: `uptime`, `df -h`, `free -h`, `docker ps -a`,
   `systemctl is-active` for any control-plane units, and `tail` of relevant
   container logs via `docker compose logs` (or `scripts/logs.sh --env staging`).
3. Identify which of `caddy/api/web/worker/postgres/redis` are stopped, crash-looping,
   unhealthy, or missing. Record exit codes and the most recent error lines only.

**Do not** `docker restart`, `compose up`, or edit anything in this pass.

### Pass 4 — Compose / migration / health (observe only, if containers exist)

1. Read `docker compose ps` against `docker-compose.yaml -f docker-compose.staging.yaml`.
2. Read the `migrate` one-shot result (completed vs failed) and the API
   healthcheck state without restarting anything.
3. Record the API health endpoint result from inside the host if the public
   probe was inconclusive.

**Approval gate:** collect a concise root-cause statement (e.g. "server running,
Caddy down with cert error"; "postgres container crash-looping OOM"; "DNS A
record no longer points at server IP") before any remediation.

## Findings Template (fill at end of each pass)

| Pass | Observation | Probable root cause | Next action | Requires approval |
| --- | --- | --- | --- | --- |
| 1 | | | | |
| 2 | | | | |
| 3 | | | | |
| 4 | | | | |

## Decision Points (operator approval required)

1. **Re-provision** if the server/state is truly gone versus restart existing.
2. **Redeploy** (`push.sh --env staging`) to fix code/config drift versus
   fix-in-place.
3. **Reset** (`reset.sh`) — wipe DB/Redis/Caddy — only if data loss is
   acceptable; staging is disposable but this must never be assumed silently.
4. **DNS/TLS** changes if the A record or certificate is the failure.
5. **Proceed to Traderton provisioning** only after Herobids staging returns to
   a known-healthy baseline.

## Deliverable

A short written diagnosis: what was wrong, the fix applied (after approval),
and confirmation that the known Herobids staging baseline is healthy again.
This becomes the evidence that Phase 1 step 2 (Traderton infrastructure) can
start from a stable base.