# Enable and Provision Nomad

Step-by-step guide to enable Nomad orchestration on an environment (`staging`
or `production`). For the full 11-step validation checklist, see
`docs/features/2026/07/08/004-orchestration/004-staging-runbook.md`.

For pitfalls and bugs encountered during initial setup, see [lessons-learnt.md](./lessons-learnt.md).
For production-specific deltas (values that differ, not just the environment
name), see [production-notes.md](../runbooks/production-notes.md).

---

## Prerequisites

- The control-plane server is provisioned and healthy (run the smoke test first — see `deploy.md`).
- `<env>.tfvars` is populated (copy from `environment.tfvars.example` if not).
- Manual Terraform commands below run in the env's own data dir, `TF_DATA_DIR=.terraform-envs/<env>` (from `infra/hetzner`; set up by `provision.sh`/`deploy.sh`). The shared `.terraform/` may point at the other env.
- Your local `.env.<env>` at `infra/hetzner/.env.<env>` includes the Nomad worker config (see Step 3).
- S3 backend is configured: you have an S3 bucket, AWS credentials, and optionally a DynamoDB table for locking. See `infra/hetzner/README.md` — "Terraform Remote Backend (S3)".
- Nomad ACL token is available. If this is a fresh cluster, you will bootstrap ACLs after first boot (see Step 7b). If ACLs are already bootstrapped, have the token ready as a shell environment variable (`NOMAD_ACL_TOKEN`). See `infra/hetzner/README.md` — "Nomad ACL Authentication".

> All `ssh` commands below omit `-i <key>` — every script that takes `--env
> <env>` resolves the correct deploy key automatically via
> `scripts/_ssh_opts.sh` (reads `ssh_public_key_path` from `<env>.tfvars`). If
> you're running a raw `ssh`/`nomad` command directly (not through one of the
> scripts), use `source scripts/_ssh_opts.sh && parse_env_flag --env <env>`
> first to get `$HEROBIDS_SSH_KEY`/`$SSH_OPTS` set, or substitute the key path
> yourself (staging: `~/.ssh/herobids_deploy_key`; production:
> `~/.ssh/herobids_deploy_key_prod`).

---

## Step 1 — Push latest commits

The control-plane clones from `git_repo_url` during provisioning. Ensure your latest code is on remote.

```bash
git push
```

## Step 2 — Set Nomad variables in `<env>.tfvars`

Uncomment and set these in `infra/hetzner/<env>.tfvars`:

```hcl
# Nomad Orchestration
enable_nomad = true
nomad_version = "1.9.7"

# Agent Node Pool
agent_node_count       = 0    # start with 0, provision nodes when ready to test
min_agent_nodes        = 0    # staging only — production uses 1 (never scale to zero); see production-notes.md
max_agent_nodes        = 3    # staging default; production uses a larger pool, see production.tfvars
agent_node_server_type = "cpx22"
```

S3 backend credentials (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `TF_BACKEND_BUCKET`, etc.) and the Nomad ACL token are **not** set in tfvars. They go in a backend env file or shell environment variables:

```bash
# Option 1 (recommended): create a backend env file
cp .env.backend.example .env.backend
# fill in TF_BACKEND_BUCKET, AWS_ACCESS_KEY_ID, etc.

# Option 2: export as shell variables
export TF_BACKEND_BUCKET=your-bucket AWS_ACCESS_KEY_ID=AKIA... ...
```

See `infra/hetzner/README.md` — "Terraform Remote Backend (S3)" for full details.

Leave autoscale, scale-in, placement-failure, and alerting defaults commented out — their defaults in `variables.tf` are sensible for staging. **Production overrides most of these** (see `production.tfvars` and `production-notes.md`) — don't copy staging's commented-out defaults into production and assume they're fine as-is.

## Step 3 — Add Nomad worker config to local `.env.<env>`

Add these to `infra/hetzner/.env.<env>`. Don't guess the control-plane private
IP — read it from `terraform output -raw control_plane_private_ip` for the env
(it is normally `.2`, but Hetzner assigns it). `deploy.sh` checks these values
against `terraform output` and refuses to upload a mismatched env file:

```bash
# Nomad orchestration
RUNTIME_BACKEND=nomad
NOMAD_ADDR=http://<control-plane-private-ip>:4646
NOMAD_TOKEN=<your-nomad-acl-token>
SHARED_REDIS_HOST=<control-plane-private-ip>
SHARED_POSTGRES_HOST=<control-plane-private-ip>
```

> `NOMAD_TOKEN` is required for authenticated Nomad API access. If this is a fresh cluster,
> leave it blank and fill it in after bootstrapping ACLs in Step 7b.

To get the actual private IP after provisioning:
```bash
cd infra/hetzner && TF_DATA_DIR=.terraform-envs/<env> terraform output -raw control_plane_private_ip
```

> **Private-IP drift caveat:** these values are hardcoded strings in
> `.env.<env>`, while cloud-init resolves the real private IP dynamically at
> boot. If a re-provision ever lands a different private IP, the hardcoded
> values break silently (symptom: worker logs `nomadAddr` pointing at a dead
> address). Re-check this value after every re-provision.

## Step 4 — Terraform apply (infrastructure only, no agent nodes)

If this is the first time enabling Nomad, the control-plane's `user_data` will change (cloud-init includes Nomad config). Terraform will want to replace the server.

Temporarily set `prevent_destroy = false` in `main.tf` on the `hcloud_server.default` resource (line ~212). Do NOT commit this change — revert it after apply.

Initialize with the S3 backend before applying:

```bash
cd infra/hetzner

# Using backend env file (recommended)
./scripts/provision.sh --env <env> --var-file <env>.tfvars --backend-env-file .env.backend

# Or with shell env vars (if you exported them earlier)
./scripts/provision.sh --env <env> --var-file <env>.tfvars
```

This provisions the private network, firewall, and attaches the control-plane. With `agent_node_count = 0`, no agent nodes are created yet.

## Step 5 — Wait for cloud-init (3–5 minutes)

```bash
# Get the new server IP (may have changed if server was recreated)
cd infra/hetzner && TF_DATA_DIR=.terraform-envs/<env> terraform output -raw server_ipv4

# Clear stale host key if IP was reused
ssh-keygen -R <server-ip>

# Monitor cloud-init
ssh root@<server-ip> 'tail -f /var/log/cloud-init-output.log'
# Wait for: "Cloud-init complete (<env>)."
```

## Step 6 — Deploy the application

```bash
infra/hetzner/deploy.sh --env <env> <server-ip> --env-file infra/hetzner/.env.<env> --backend-env-file infra/hetzner/.env.backend
```

This uploads `.env.<env>` (app secrets), `autoscale.env` (backend credentials from `--backend-env-file`), builds, and starts all services.

## Step 7 — Verify Nomad server

```bash
SERVER_IP=$(cd infra/hetzner && TF_DATA_DIR=.terraform-envs/<env> terraform output -raw server_ipv4)

# Server should be alive, advertising the private IP (10.x.x.x), NOT 172.17.x.x
ssh root@${SERVER_IP} 'nomad server members'

# Worker should report Runtime backend: nomad with the correct address
ssh root@${SERVER_IP} \
  'cd /opt/herobids && docker compose -f docker-compose.yaml -f docker-compose.<overlay>.yaml logs worker 2>&1 | grep -EA2 "Runtime backend|NomadRuntimeAdapter initialized"'
# <overlay> is "staging" or "prod" — see docker-compose.<overlay>.yaml in the repo root.

# No agent nodes yet (expected with agent_node_count=0)
ssh root@${SERVER_IP} 'nomad node status'
```

## Step 7b — Bootstrap Nomad ACLs (first time only)

If this is a fresh cluster without an ACL token:

```bash
# SSH to the control plane and bootstrap ACLs
ssh root@${SERVER_IP} 'nomad acl bootstrap'
```

Save the management token from the output. Then:

1. Export `NOMAD_ACL_TOKEN` in your shell (or `.envrc`):
   ```bash
   export NOMAD_ACL_TOKEN=<management-token>
   ```

2. Add `NOMAD_TOKEN` to your `.env.<env>`:
   ```bash
   NOMAD_TOKEN=<management-token>
   ```

3. Redeploy to upload the autoscale env file (which includes the token) and pick up the worker token:
   ```bash
   infra/hetzner/deploy.sh --env <env> ${SERVER_IP} --env-file infra/hetzner/.env.<env>
   ```

4. Verify authenticated access:
   ```bash
   ssh root@${SERVER_IP} "NOMAD_TOKEN=<management-token> nomad node status"
   ```

> Prefer `setup-nomad.sh` over doing this by hand — it bootstraps, writes the
> token to both `.env.backend` and `.env.<env>`, redeploys, and verifies, in
> one step. See the Reprovision runbook (`../runbooks/reprovision-runbook.md`),
> step 6.

## Step 8 — Flip `prevent_destroy` back to `true`

In `main.tf`, change `prevent_destroy = false` back to `prevent_destroy = true` on `hcloud_server.default`.

## Step 9 — Provision an agent node

When ready to test agent launching:

```bash
cd infra/hetzner
export TF_DATA_DIR=.terraform-envs/<env>
terraform apply -var-file=<env>.tfvars -var="agent_node_count=1"
```

**Important:** This will trigger a control-plane replacement because `agent_node_count` is embedded in cloud-init `user_data` (see [lessons-learnt.md](./lessons-learnt.md#5-agent_node_count-in-cloud-init-causes-unnecessary-server-replacement)). You'll need `prevent_destroy = false` again temporarily, and you'll need to redeploy after.

Alternatively, set `agent_node_count = 1` in `<env>.tfvars` before the initial apply in Step 4 to avoid this extra cycle. (Production's `production.tfvars` already does this — `agent_node_count = 1` from the start.)

Wait 3–5 minutes for the agent node's cloud-init, then verify:

```bash
ssh root@${SERVER_IP} 'nomad node status'
# Expected: 1 node, status "ready", eligibility "eligible"
```

## Step 10 — Run smoke tests

Run the base smoke test:

```bash
cd infra/hetzner && ./scripts/smoke-test.sh --env <env>
```

Then run the full reset-and-run to verify agents, connections, and credentials:

```bash
infra/hetzner/scripts/reset-and-run.sh --env <env> --env-file .env.ops.<env>
```

> On production, confirm the Traderton production boundary is actually up
> before running this — see `production-notes.md` § Traderton production
> dependency. If it isn't, this step will provision users/skills/admin fine
> but fail linking venue connections (a `transport_error`/`503`, not a
> herobids bug).

## Step 11 — Run the orchestration validation checklist

Proceed with the 11-step runbook at `docs/features/2026/07/08/004-orchestration/004-staging-runbook.md` (Steps 3–11).

---

## Quick Reference

See [useful-commands.md](./useful-commands.md) for the full day-2 command
reference (SSH, Nomad status, autoscale, troubleshooting). Quick links for
this setup flow:

| What | Command |
|---|---|
| Server IP | `cd infra/hetzner && TF_DATA_DIR=.terraform-envs/<env> terraform output -raw server_ipv4` |
| Agent node IPs | `cd infra/hetzner && TF_DATA_DIR=.terraform-envs/<env> terraform output -json agent_node_public_ips` |
| Private IP | `cd infra/hetzner && TF_DATA_DIR=.terraform-envs/<env> terraform output -raw control_plane_private_ip` |
| Nomad server status | `ssh root@<ip> 'nomad server members'` |
| Nomad node status | `ssh root@<ip> 'nomad node status'` |
| Deploy | `infra/hetzner/deploy.sh --env <env> <ip> --env-file infra/hetzner/.env.<env>` |
| Full reset + provision | `infra/hetzner/scripts/reset-and-run.sh --env <env> --env-file .env.ops.<env>` |
