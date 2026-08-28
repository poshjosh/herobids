# Useful Commands — Nomad Staging

Quick-reference commands for operating the Nomad staging cluster.

Server IP and agent node IPs change on recreation. Always check first:
```bash
cd infra/hetzner

# Ensure you're initialized with the S3 backend and on the right workspace
terraform workspace select staging

terraform output -raw server_ipv4          # control-plane public IP
terraform output -raw control_plane_private_ip  # control-plane private IP
terraform output -json agent_node_public_ips    # agent node public IPs
```

---

## SSH

```bash
# Control-plane
ssh -i ~/.ssh/herobids_deploy_key root@<server-ip>

# Agent node
ssh -i ~/.ssh/herobids_deploy_key root@<agent-ip>

# Clear stale host key after server recreation
ssh-keygen -R <ip>
```

## Nomad Status

All `nomad` commands on an ACL-enabled cluster require the token. Set `NOMAD_TOKEN` in your shell or pass it inline:

```bash
# Set once per SSH session
export NOMAD_TOKEN=<your-nomad-acl-token>

# Server members (should advertise 10.x.x.x, NOT 172.17.x.x)
ssh -i ~/.ssh/herobids_deploy_key root@<server-ip> \
  "NOMAD_TOKEN=<token> nomad server members"

# Client nodes (should show "ready" / "eligible")
ssh -i ~/.ssh/herobids_deploy_key root@<server-ip> \
  "NOMAD_TOKEN=<token> nomad node status"

# Running jobs
ssh -i ~/.ssh/herobids_deploy_key root@<server-ip> \
  "NOMAD_TOKEN=<token> nomad job status -namespace=herobids-agents"
```

> On the control plane, the systemd services have `NOMAD_TOKEN` in their environment.
> For interactive SSH sessions, you must set it yourself.

## Worker Logs

```bash
# Check runtime backend and Nomad address
ssh -i ~/.ssh/herobids_deploy_key root@<server-ip> \
  'cd /opt/herobids && docker compose -f docker-compose.yaml -f docker-compose.staging.yaml logs worker 2>&1 | grep -EA2 "Runtime backend|NomadRuntimeAdapter"'

# Full worker logs (last 50 lines)
ssh -i ~/.ssh/herobids_deploy_key root@<server-ip> \
  'cd /opt/herobids && docker compose -f docker-compose.yaml -f docker-compose.staging.yaml logs --tail=50 worker'
```

## Cloud-init

```bash
# Check cloud-init completion on control-plane
ssh -i ~/.ssh/herobids_deploy_key root@<server-ip> 'tail -5 /var/log/cloud-init-output.log'

# Check cloud-init completion on agent node
ssh -i ~/.ssh/herobids_deploy_key root@<agent-ip> 'tail -5 /var/log/cloud-init-output.log'
```

## Provision Agent Nodes

Requires `prevent_destroy = false` on `hcloud_server.default` in `main.tf` (because `agent_node_count` is in cloud-init user_data). Flip it back to `true` after.

```bash
cd infra/hetzner
terraform workspace select staging
terraform apply -var-file=staging.tfvars -var="agent_node_count=1"
```

Wait 3–5 min for cloud-init, then verify:
```bash
ssh -i ~/.ssh/herobids_deploy_key root@<server-ip> 'nomad node status'
```

## Deploy

```bash
# Full deploy (upload .env, git pull, build, compose up, health check)
infra/hetzner/deploy.sh --env staging --env-file infra/hetzner/.env.staging

# Just restart the worker
ssh -i ~/.ssh/herobids_deploy_key root@<server-ip> \
  'cd /opt/herobids && docker compose -f docker-compose.yaml -f docker-compose.staging.yaml up -d --force-recreate worker'
```

## Reset + Full Provision (destructive)

Wipes DB, Redis, Caddy certs. Seeds admin, provisions user/connections/agents.

```bash
infra/hetzner/scripts/reset-and-run.sh --env staging --env-file .env.ops.staging
```

## Autoscale

The autoscale scripts read `NOMAD_TOKEN` from the systemd environment automatically. For manual invocations via SSH, set `NOMAD_TOKEN` in the environment:

```bash
# Check cluster capacity (NOMAD_TOKEN from systemd env)
ssh -i ~/.ssh/herobids_deploy_key root@<server-ip> \
  "NOMAD_TOKEN=<token> /opt/herobids/infra/hetzner/scripts/check-nomad-capacity.sh"

# Force scale-out (bypass thresholds)
ssh -i ~/.ssh/herobids_deploy_key root@<server-ip> \
  "NOMAD_TOKEN=<token> /opt/herobids/infra/hetzner/scripts/scale-out.sh --force"

# Dry-run scale-out
ssh -i ~/.ssh/herobids_deploy_key root@<server-ip> \
  "NOMAD_TOKEN=<token> /opt/herobids/infra/hetzner/scripts/scale-out.sh --dry-run"

# Dry-run scale-in (must enable explicitly)
ssh -i ~/.ssh/herobids_deploy_key root@<server-ip> \
  "NOMAD_TOKEN=<token> ENABLE_SCALE_IN=true /opt/herobids/infra/hetzner/scripts/scale-in.sh --dry-run"

# Autoscale timer status
ssh -i ~/.ssh/herobids_deploy_key root@<server-ip> 'systemctl status nomad-autoscale.timer'

# Autoscale logs
ssh -i ~/.ssh/herobids_deploy_key root@<server-ip> 'tail -50 /var/log/nomad-autoscale.log'
```

## Nomad Agent Node Troubleshooting

```bash
# Nomad client logs on the agent node
ssh -i ~/.ssh/herobids_deploy_key root@<agent-ip> 'journalctl -u nomad --no-pager -n 30'

# Check Nomad client config
ssh -i ~/.ssh/herobids_deploy_key root@<agent-ip> 'cat /etc/nomad.d/nomad.hcl'

# Check private network connectivity from agent to control-plane
ssh -i ~/.ssh/herobids_deploy_key root@<agent-ip> 'nc -zv <control-plane-private-ip> 4647'

# Restart Nomad on agent node
ssh -i ~/.ssh/herobids_deploy_key root@<agent-ip> 'systemctl restart nomad'
```

## Scale-In Drain Timeout Investigation

When a scale-in drain times out, the node is NOT destroyed — it stays in the cluster
and is re-marked eligible. The autoscale log reports the timeout with a `WARNING` line.

**Identify the timed-out node:**

```bash
# Check the autoscale log for drain timeout warnings
ssh -i ~/.ssh/herobids_deploy_key root@<server-ip> \
  'grep "did not drain within" /var/log/nomad-autoscale.log | tail -10'
```

**Inspect the node and its allocations:**

```bash
# Node status — shows drain state, eligibility, and allocation summary
ssh -i ~/.ssh/herobids_deploy_key root@<server-ip> \
  "NOMAD_TOKEN=<token> nomad node status <node-id>"

# List allocations on the node — look for running/pending that blocked the drain
ssh -i ~/.ssh/herobids_deploy_key root@<server-ip> \
  "NOMAD_TOKEN=<token> nomad node status -verbose <node-id>"
```

**Inspect stuck allocations:**

```bash
# Allocation detail — check DesiredStatus, ClientStatus, and task events
ssh -i ~/.ssh/herobids_deploy_key root@<server-ip> \
  "NOMAD_TOKEN=<token> nomad alloc status <alloc-id>"

# Allocation logs — check for application errors preventing graceful shutdown
ssh -i ~/.ssh/herobids_deploy_key root@<server-ip> \
  "NOMAD_TOKEN=<token> nomad alloc logs <alloc-id>"
```

**After resolving the stuck allocation:**

The next nightly scale-in run will re-evaluate the node. If it is idle, it will be
drained and removed normally. No manual intervention is needed to retry.

## Terraform Backend Initialization Failure

When the autoscale service fails with `S3 backend not configured` or
`Terraform backend initialization failed`, the control-plane cannot run
Terraform operations.

**Check the service environment:**

```bash
ssh -i ~/.ssh/herobids_deploy_key root@<server-ip>

# Verify the backend env vars are set in the autoscale service
systemctl show nomad-autoscale.service -p Environment | tr ' ' '\n' | grep -E 'TF_BACKEND|AWS_'
systemctl show nomad-scale-in.service -p Environment | tr ' ' '\n' | grep -E 'TF_BACKEND|AWS_'

# Expected: TF_BACKEND_BUCKET, TF_BACKEND_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
```

**Verify backend connectivity:**

```bash
# Try a manual terraform init
cd /opt/herobids/infra/hetzner
terraform init \
  -backend-config="bucket=${TF_BACKEND_BUCKET}" \
  -backend-config="key=herobids/${HEROBIDS_ENV}/terraform.tfstate" \
  -backend-config="region=${TF_BACKEND_REGION}"

# If init fails, check AWS credentials
aws sts get-caller-identity  # requires awscli

# Check the S3 bucket is accessible
aws s3 ls "s3://${TF_BACKEND_BUCKET}/herobids/" --region "${TF_BACKEND_REGION}"
```

**Common causes:**

| Symptom | Cause | Fix |
|---|---|---|
| `Missing backend environment variables` | Backend vars not in systemd service | Re-provision with backend vars in tfvars, or add to systemd override |
| `Error configuring S3 backend` | Invalid credentials or bucket | Verify AWS credentials; check bucket exists and region matches |
| `Error acquiring the state lock` | Previous terraform run interrupted | `terraform force-unlock <LOCK_ID>` |
| `Failed to select workspace` | First run on new environment | The scripts auto-create the workspace; check for underlying init error |

**After fixing:**

```bash
# Verify by running a dry-run
NOMAD_TOKEN=<token> /opt/herobids/infra/hetzner/scripts/scale-out.sh --dry-run
```

## Nomad Token Authentication Failure

When autoscale scripts fail with `HTTP 403` or `Permission denied`, the Nomad
ACL token is missing or invalid.

**Verify the token is set:**

```bash
ssh -i ~/.ssh/herobids_deploy_key root@<server-ip>

# Check autoscale service environment
systemctl show nomad-autoscale.service -p Environment | tr ' ' '\n' | grep NOMAD_TOKEN

# Check scale-in service environment
systemctl show nomad-scale-in.service -p Environment | tr ' ' '\n' | grep NOMAD_TOKEN

# Test the token against the Nomad API directly
NOMAD_TOKEN=<token> nomad node status
# Expected: list of nodes. If 403 → token is invalid or expired.
```

**Verify the worker token:**

```bash
# Check the worker container's environment
ssh -i ~/.ssh/herobids_deploy_key root@<server-ip> \
  'cd /opt/herobids && docker compose exec worker env | grep NOMAD_TOKEN'

# Check worker logs for auth errors
ssh -i ~/.ssh/herobids_deploy_key root@<server-ip> \
  'cd /opt/herobids && docker compose logs --tail=30 worker 2>&1 | grep -i "403\|denied\|auth"'
```

**Common causes:**

| Symptom | Cause | Fix |
|---|---|---|
| `HTTP 403` in autoscale log | Token missing or wrong in systemd env | Set `nomad_acl_token` in tfvars and re-provision |
| `Permission denied` in worker | `NOMAD_TOKEN` missing from `.env` file | Add token to `.env.prod` / `.env.staging` and redeploy |
| Token was valid, now rejected | Bootstrap reset or cluster recreated | Re-bootstrap ACLs: `nomad acl bootstrap` and update all consumers |

**After fixing:**

```bash
# Verify autoscale can authenticate
NOMAD_TOKEN=<token> /opt/herobids/infra/hetzner/scripts/check-nomad-capacity.sh

# Verify scale-in can authenticate
NOMAD_TOKEN=<token> ENABLE_SCALE_IN=true \
  /opt/herobids/infra/hetzner/scripts/scale-in.sh --dry-run
```

## Staging Validation: Intentional Drain Timeout

When using the staging failure injection hooks (`staging-hooks.sh`) to validate
drain-timeout handling for the production validation plan:

**Before the test:**

```bash
ssh -i ~/.ssh/herobids_deploy_key root@<server-ip>

# Record the current cluster state
NOMAD_TOKEN=<token> nomad node status
# Note node IDs, eligibility, and drain state
```

**During the test:**

```bash
# The staging hook makes wait_for_drain_complete always fail.
# The script should:
#   1. Log "[STAGING-HOOK] Simulating drain timeout ..."
#   2. Log "WARNING: Node <id> did not drain within ..."
#   3. Re-mark the node as eligible
#   4. Skip the node in the Terraform shrink

# Check the autoscale log
tail -50 /var/log/nomad-autoscale.log | grep -E 'STAGING-HOOK|WARNING|DRAIN_OK|terraform'
```

**After the test:**

```bash
# Verify all nodes are back to normal
NOMAD_TOKEN=<token> nomad node status
# All nodes should be "ready" and "eligible"

# Verify no unexpected Terraform changes happened
cd /opt/herobids/infra/hetzner
terraform plan
# Expected: no changes (or only unrelated drift)
```
