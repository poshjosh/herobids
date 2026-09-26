# Enable and Provision Nomad for Staging

Step-by-step guide to enable Nomad orchestration on staging. For the full 11-step validation checklist, see `docs/features/2026/07/08/004-orchestration/004-staging-runbook.md`.

For pitfalls and bugs encountered during initial setup, see [lessons-learnt.md](./lessons-learnt.md).

---

## Prerequisites

- Staging control-plane server is provisioned and healthy (run `docs/runbooks/smoke-test-staging.md` first).
- `staging.tfvars` is populated (copy from `environment.tfvars.example` if not).
- You are on the `staging` Terraform workspace: `terraform workspace select staging`.
- Your local `.env.staging` at `infra/hetzner/.env.staging` includes the Nomad worker config (see Step 4).
- S3 backend is configured: you have an S3 bucket, AWS credentials, and optionally a DynamoDB table for locking. See `infra/hetzner/README.md` — "Terraform Remote Backend (S3)".
- Nomad ACL token is available. If this is a fresh cluster, you will bootstrap ACLs after first boot (see Step 7b). If ACLs are already bootstrapped, have the token ready as a shell environment variable (`NOMAD_ACL_TOKEN`). See `infra/hetzner/README.md` — "Nomad ACL Authentication".

---

## Step 1 — Push latest commits

The control-plane clones from `git_repo_url` during provisioning. Ensure your latest code is on remote.

```bash
git push
```

## Step 2 — Set Nomad variables in `staging.tfvars`

Uncomment and set these in `infra/hetzner/staging.tfvars`:

```hcl
# Nomad Orchestration
enable_nomad = true
nomad_version = "1.9.7"

# Agent Node Pool
agent_node_count       = 0    # start with 0, provision nodes when ready to test
min_agent_nodes        = 0    # allow scale-in to 0
max_agent_nodes        = 3
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

Leave autoscale, scale-in, placement-failure, and alerting defaults commented out — their defaults in `variables.tf` are sensible for staging.

## Step 3 — Add Nomad worker config to local `.env.staging`

Add these to `infra/hetzner/.env.staging` (the control-plane private IP is `10.0.0.2` by default):

```bash
# Nomad orchestration
RUNTIME_BACKEND=nomad
NOMAD_ADDR=http://10.0.0.2:4646
NOMAD_TOKEN=<your-nomad-acl-token>
SHARED_REDIS_HOST=10.0.0.2
SHARED_POSTGRES_HOST=10.0.0.2
```

> `NOMAD_TOKEN` is required for authenticated Nomad API access. If this is a fresh cluster,
> leave it blank and fill it in after bootstrapping ACLs in Step 7b.

To get the actual private IP after provisioning:
```bash
cd infra/hetzner && terraform output -raw control_plane_private_ip
```

## Step 4 — Terraform apply (infrastructure only, no agent nodes)

If this is the first time enabling Nomad, the control-plane's `user_data` will change (cloud-init includes Nomad config). Terraform will want to replace the server.

Temporarily set `prevent_destroy = false` in `main.tf` on the `hcloud_server.default` resource (line ~212). Do NOT commit this change — revert it after apply.

Initialize with the S3 backend before applying:

```bash
cd infra/hetzner

# Using backend env file (recommended)
./scripts/provision.sh --env staging --var-file staging.tfvars --backend-env-file .env.backend

# Or with shell env vars (if you exported them earlier)
./scripts/provision.sh --env staging --var-file staging.tfvars
```

This provisions the private network, firewall, and attaches the control-plane. With `agent_node_count = 0`, no agent nodes are created yet.

## Step 5 — Wait for cloud-init (3–5 minutes)

```bash
# Get the new server IP (may have changed if server was recreated)
terraform output -raw server_ipv4

# Clear stale host key if IP was reused
ssh-keygen -R <server-ip>

# Monitor cloud-init
ssh -i ~/.ssh/herobids_deploy_key root@<server-ip> 'tail -f /var/log/cloud-init-output.log'
# Wait for: "Cloud-init complete (staging)."
```

## Step 6 — Deploy the application

```bash
infra/hetzner/deploy.sh --env staging --env-file infra/hetzner/.env.staging --backend-env-file infra/hetzner/.env.backend
```

This uploads `.env.staging` (app secrets), `autoscale.env` (backend credentials from `--backend-env-file`), builds, and starts all services.

## Step 7 — Verify Nomad server

```bash
SERVER_IP=$(cd infra/hetzner && terraform output -raw server_ipv4)

# Server should be alive, advertising the private IP (10.x.x.x), NOT 172.17.x.x
ssh -i ~/.ssh/herobids_deploy_key root@${SERVER_IP} 'nomad server members'

# Worker should report Runtime backend: nomad with the correct address
ssh -i ~/.ssh/herobids_deploy_key root@${SERVER_IP} \
  'cd /opt/herobids && docker compose -f docker-compose.yaml -f docker-compose.staging.yaml logs worker 2>&1 | grep -EA2 "Runtime backend|NomadRuntimeAdapter initialized"'

# No agent nodes yet (expected with agent_node_count=0)
ssh -i ~/.ssh/herobids_deploy_key root@${SERVER_IP} 'nomad node status'
```

## Step 7b — Bootstrap Nomad ACLs (first time only)

If this is a fresh cluster without an ACL token:

```bash
# SSH to the control plane and bootstrap ACLs
ssh -i ~/.ssh/herobids_deploy_key root@${SERVER_IP} 'nomad acl bootstrap'
```

Save the management token from the output. Then:

1. Export `NOMAD_ACL_TOKEN` in your shell (or `.envrc`):
   ```bash
   export NOMAD_ACL_TOKEN=<management-token>
   ```

2. Add `NOMAD_TOKEN` to your `.env.staging`:
   ```bash
   NOMAD_TOKEN=<management-token>
   ```

3. Redeploy to upload the autoscale env file (which includes the token) and pick up the worker token:
   ```bash
   infra/hetzner/deploy.sh --env staging --env-file infra/hetzner/.env.staging
   ```

4. Verify authenticated access:
   ```bash
   ssh -i ~/.ssh/herobids_deploy_key root@${SERVER_IP} \
     "NOMAD_TOKEN=<management-token> nomad node status"
   ```

## Step 8 — Flip `prevent_destroy` back to `true`

In `main.tf`, change `prevent_destroy = false` back to `prevent_destroy = true` on `hcloud_server.default`.

## Step 9 — Provision an agent node

When ready to test agent launching:

```bash
cd infra/hetzner
terraform apply -var-file=staging.tfvars -var="agent_node_count=1"
```

**Important:** This will trigger a control-plane replacement because `agent_node_count` is embedded in cloud-init `user_data` (see [lessons-learnt.md](./lessons-learnt.md#5-agent_node_count-in-cloud-init-causes-unnecessary-server-replacement)). You'll need `prevent_destroy = false` again temporarily, and you'll need to redeploy after.

Alternatively, set `agent_node_count = 1` in `staging.tfvars` before the initial apply in Step 4 to avoid this extra cycle.

Wait 3–5 minutes for the agent node's cloud-init, then verify:

```bash
ssh -i ~/.ssh/herobids_deploy_key root@${SERVER_IP} 'nomad node status'
# Expected: 1 node, status "ready", eligibility "eligible"
```

## Step 10 — Run smoke tests

Run the base staging smoke test:

```bash
cd infra/hetzner && ./scripts/smoke-test.sh --env staging
```

Then run the full reset-and-run to verify agents, connections, and credentials:

```bash
infra/hetzner/scripts/reset-and-run.sh --env staging --env-file .env.ops.staging
```

## Step 11 — Run the orchestration validation checklist

Proceed with the 11-step runbook at `docs/features/2026/07/08/004-orchestration/004-staging-runbook.md` (Steps 3–11).

---

## Quick Reference

| What | Command |
|---|---|
| Server IP | `cd infra/hetzner && terraform output -raw server_ipv4` |
| Agent node IPs | `cd infra/hetzner && terraform output -json agent_node_public_ips` |
| Private IP | `cd infra/hetzner && terraform output -raw control_plane_private_ip` |
| Nomad server status | `ssh -i ~/.ssh/herobids_deploy_key root@<ip> 'nomad server members'` |
| Nomad node status | `ssh -i ~/.ssh/herobids_deploy_key root@<ip> 'nomad node status'` |
| Worker logs (Nomad) | `ssh -i ~/.ssh/herobids_deploy_key root@<ip> 'cd /opt/herobids && docker compose -f docker-compose.yaml -f docker-compose.staging.yaml logs worker 2>&1 \| grep -EA2 "Runtime backend\|NomadRuntimeAdapter"'` |
| Agent node cloud-init | `ssh -i ~/.ssh/herobids_deploy_key root@<agent-ip> 'tail -5 /var/log/cloud-init-output.log'` |
| Clear stale host key | `ssh-keygen -R <ip>` |
| Deploy | `infra/hetzner/deploy.sh --env staging --env-file infra/hetzner/.env.staging` |
| Full reset + provision | `infra/hetzner/scripts/reset-and-run.sh --env staging --env-file .env.ops.staging` |
