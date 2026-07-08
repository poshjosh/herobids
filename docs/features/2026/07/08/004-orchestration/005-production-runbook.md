# Production Orchestration Runbook

> **Feature:** 004-orchestration (Phases 1–9)
> **Environment:** Production (`NODE_ENV=production`, `HEROBIDS_ENV=production`)
> **Last updated:** 2026-07-08

This runbook covers Nomad-based agent orchestration for the production environment. Staging must pass the full validation checklist in `004-staging-runbook.md` before production rollout.

---

## Pre-requisites

1. **Staging orchestration validation is complete.** All steps in `004-staging-runbook.md` passed.

2. **Production control plane is healthy.** API, web, Caddy, worker all green.

3. **Nomad is provisioned and enabled:**

   ```bash
   cd infra/hetzner
   terraform output -var-file=production.tfvars nomad_enabled
   # Expected: true
   ```

4. **At least `min_agent_nodes` (default: 2) agent nodes are provisioned:**

   ```bash
   terraform output -var-file=production.tfvars agent_node_count
   # Expected: >= min_agent_nodes (typically 2)
   ```

5. **SMTP alerting is configured and tested.** Production MUST have alerting — do not proceed without it.

   ```bash
   ssh $(terraform output -var-file=production.tfvars -raw server_ipv4) \
     '/opt/herobids/infra/hetzner/scripts/send-alert.sh --test'
   ```

6. **You have SSH access to all nodes:**

   ```bash
   terraform output -var-file=production.tfvars ssh_command
   terraform output -var-file=production.tfvars agent_ssh_commands
   ```

---

## Environment-Specific Defaults

| Variable | Production Value |
|---|---|
| `HEROBIDS_ENV` | `production` |
| `network_ip_range` | `10.1.0.0/16` |
| `subnet_ip_range` | `10.1.0.0/24` |
| `server_name` | `herobids` |
| `nomad_version` | `1.9.7` |
| `agent_node_server_type` | `cpx21` (2 vCPU, 4 GB) |
| `agent_memory_reservation_mb` | `256` |
| `min_agent_nodes` | `2` |
| `max_agent_nodes` | `10` |
| `scale_out_cooldown_seconds` | `300` |
| `scale_out_memory_threshold_pct` | `20` |
| `scale_out_slot_threshold` | `3` |
| `scale_out_increment` | `1` |
| `enable_scale_in` | `false` (enable after monitoring validates stability) |
| `scale_in_time_utc` | `"3"` |
| `alert_failure_threshold` | `3` |
| `alert_rate_limit_seconds` | `3600` |
| `placement_failure_window_seconds` | `300` |
| `placement_failure_threshold` | `5` |
| `placement_failure_cooldown_seconds` | `600` |
| `prevent_destroy` (Terraform) | `true` — accidental destroy is blocked |

> ⚠️ **Network CIDR collision:** If staging and production share the same Hetzner project, their private network CIDRs MUST NOT overlap. Staging uses `10.0.0.0/16`, production uses `10.1.0.0/16`.

---

## Step 1 — Provision the Production Orchestration Cluster

```bash
cd infra/hetzner

# Copy and edit the production tfvars
cp production.tfvars.example production.tfvars
# Edit: fill in hcloud_token, ssh_public_key_path, deploy_ssh_private_key,
#       git_repo_url, agent_node_count (set to min_agent_nodes or more),
#       SMTP vars (REQUIRED for production).

# Provision
./scripts/provision.sh --env production --var-file production.tfvars

# Verify outputs
terraform output -var-file=production.tfvars
```

Wait 3–5 minutes for cloud-init to complete. Verify that `prevent_destroy` is set:

```bash
terraform state show -var-file=production.tfvars 'hcloud_server.default' | grep prevent_destroy
# Expected: prevent_destroy = true
```

---

## Step 2 — Configure the Worker for Nomad

```bash
CONTROL_PLANE_IP=$(terraform output -var-file=production.tfvars -raw control_plane_private_ip)

ssh root@$(terraform output -var-file=production.tfvars -raw server_ipv4) <<EOF
cat >> /opt/herobids/.env.prod <<ENV

# Nomad orchestration (Phase 4)
RUNTIME_BACKEND=nomad
NOMAD_ADDR=http://${CONTROL_PLANE_IP}:4646

# Cluster-safe shared services (Phase 3)
SHARED_REDIS_HOST=${CONTROL_PLANE_IP}
SHARED_POSTGRES_HOST=${CONTROL_PLANE_IP}
ENV

# Restart worker
cd /opt/herobids && docker compose -f docker-compose.yaml -f docker-compose.prod.yaml up -d --force-recreate worker
EOF
```

Verify the worker picked up the Nomad backend:

```bash
ssh root@$(terraform output -var-file=production.tfvars -raw server_ipv4) \
  'docker compose -f docker-compose.yaml -f docker-compose.prod.yaml logs --tail=30 worker | grep "Runtime backend"'
# Expected: "Runtime backend: nomad"
```

---

## Step 3 — Validate Cluster Health

```bash
CONTROL_IP=$(terraform output -var-file=production.tfvars -raw server_ipv4)

# Nomad server and clients
ssh root@${CONTROL_IP} 'nomad server members'
ssh root@${CONTROL_IP} 'nomad node status'
# Expected: 1 server + min_agent_nodes clients, all "ready"

# Autoscale timers active
ssh root@${CONTROL_IP} 'systemctl list-timers nomad-autoscale.timer nomad-placement-failure-watcher.timer'
# Expected: both timers show "active" and next run time

# Verify no scale-in timer (disabled by default in production)
ssh root@${CONTROL_IP} 'systemctl is-enabled nomad-scale-in.timer || echo "scale-in disabled (expected)"'
```

---

## Step 4 — Agent Lifecycle Validation

Run the same validation checks as staging (Steps 4–7 of `004-staging-runbook.md`), substituting production endpoints:

```bash
PROD_API="https://herobids.com/api"
CONTROL_IP=$(terraform output -var-file=production.tfvars -raw server_ipv4)

# 1. Launch agent → verify Nomad allocation
# 2. Stop agent → verify clean stop (not crash)
# 3. Force-kill → verify crash detection within ~30s
# 4. Restart worker → verify reconciliation recovers state
```

See `004-staging-runbook.md` Steps 4–7 for detailed commands.

---

## Step 5 — Autoscaling Validation

### 5.1 Check current capacity snapshot

```bash
ssh root@${CONTROL_IP} '/opt/herobids/infra/hetzner/scripts/check-nomad-capacity.sh'
ssh root@${CONTROL_IP} '/opt/herobids/infra/hetzner/scripts/check-nomad-capacity.sh --json | jq .'
```

### 5.2 Dry-run scale-out

```bash
ssh root@${CONTROL_IP} '/opt/herobids/infra/hetzner/scripts/scale-out.sh --dry-run'
```

### 5.3 Force scale-out to add capacity

```bash
# Do NOT force in production unless capacity is genuinely needed.
# Use dry-run first.
ssh root@${CONTROL_IP} '/opt/herobids/infra/hetzner/scripts/scale-out.sh --force'
```

### 5.4 Verify new node

```bash
ssh root@${CONTROL_IP} 'nomad node status'
ssh root@${CONTROL_IP} 'cd /opt/herobids/infra/hetzner && terraform state list | grep hcloud_server.agent'
```

### 5.5 Placement-failure safety net

```bash
ssh root@${CONTROL_IP} '/opt/herobids/infra/hetzner/scripts/check-placement-failures.sh --dry-run'
```

---

## Step 6 — Alerting Validation

```bash
CONTROL_IP=$(terraform output -var-file=production.tfvars -raw server_ipv4)

# Test alert delivery (REQUIRED — do not skip)
ssh root@${CONTROL_IP} '/opt/herobids/infra/hetzner/scripts/send-alert.sh --test'

# Verify SMTP delivery in journal
ssh root@${CONTROL_IP} 'journalctl -t nomad-autoscale-alert -n 10'

# Verify alert rate-limiting works
ssh root@${CONTROL_IP} 'cat /var/run/nomad-autoscale-failure-count'
ssh root@${CONTROL_IP} 'cat /var/run/nomad-autoscale-last-alert'
```

---

## Manual Fallback Procedures

### If Nomad is unhealthy

```bash
CONTROL_IP=$(terraform output -var-file=production.tfvars -raw server_ipv4)

# Check and restart Nomad
ssh root@${CONTROL_IP} 'systemctl status nomad'
ssh root@${CONTROL_IP} 'nomad server members'
ssh root@${CONTROL_IP} 'systemctl restart nomad'
sleep 10
ssh root@${CONTROL_IP} 'nomad server members'

# Agent node not joining
AGENT_IP=$(terraform output -var-file=production.tfvars -json agent_node_public_ips | jq -r '.[0]')
ssh root@${AGENT_IP} 'systemctl status nomad'
ssh root@${AGENT_IP} 'tail -100 /var/log/cloud-init-output.log'
```

### If autoscale loop is stuck

```bash
# Check timers
ssh root@${CONTROL_IP} 'systemctl list-timers'
ssh root@${CONTROL_IP} 'systemctl status nomad-autoscale.service'

# Check for Terraform lock
ssh root@${CONTROL_IP} 'cd /opt/herobids/infra/hetzner && terraform plan'

# Force-unlock if needed
ssh root@${CONTROL_IP} 'cd /opt/herobids/infra/hetzner && terraform force-unlock <LOCK_ID>'

# Manual scale-out
ssh root@${CONTROL_IP} 'cd /opt/herobids/infra/hetzner && terraform apply -auto-approve -var-file=production.tfvars -var="agent_node_count=<N+1>"'
ssh root@${CONTROL_IP} 'echo "<N+1>" > /var/run/nomad-autoscale-node-count'

# View autoscale logs
ssh root@${CONTROL_IP} 'tail -100 /var/log/nomad-autoscale.log'
ssh root@${CONTROL_IP} 'journalctl -u nomad-autoscale -u nomad-scale-in -u nomad-placement-failure-watcher -n 100'
```

### If alerting is not working

```bash
# Check SMTP connectivity
ssh root@${CONTROL_IP} '/opt/herobids/infra/hetzner/scripts/send-alert.sh --test --dry-run'

# Verify bsd-mailx is installed
ssh root@${CONTROL_IP} 'which sendmail || apt-get install -y bsd-mailx'

# Verify SMTP env vars are set in the service
ssh root@${CONTROL_IP} 'systemctl cat nomad-autoscale.service | grep -E "ALERT_SMTP|ALERT_FROM|ALERT_TO"'

# Fall back to logger (writes to syslog instead of email)
ssh root@${CONTROL_IP} 'journalctl -t nomad-autoscale-alert -n 20'
```

---

## Rollback to Local-Docker Runtime Mode

If the Nomad orchestration path is compromised and you need to return to the pre-Nomad
single-host model immediately, follow this procedure. Agents will run as local Docker
containers on the control-plane host.

### Phase 1 — Switch Worker to Docker Backend (immediate, < 2 min)

```bash
CONTROL_IP=$(terraform output -var-file=production.tfvars -raw server_ipv4)

ssh root@${CONTROL_IP} <<'ROLLBACK'
set -e

cd /opt/herobids

# 1. Override runtime backend to Docker
#    The env var takes priority over config/default.yaml.
if grep -q '^RUNTIME_BACKEND=nomad' .env.prod; then
  sed -i 's/^RUNTIME_BACKEND=nomad$/RUNTIME_BACKEND=docker/' .env.prod
  echo "Changed RUNTIME_BACKEND to docker in .env.prod"
fi

# 2. Restart the worker
docker compose -f docker-compose.yaml -f docker-compose.prod.yaml up -d --force-recreate worker

# 3. Verify worker booted with docker backend
sleep 5
docker compose -f docker-compose.yaml -f docker-compose.prod.yaml logs --tail=10 worker | grep "Runtime backend"
# Expected: "Runtime backend: docker"
ROLLBACK

echo "Worker is now using Docker backend. Agents will launch as local containers."
```

### Phase 2 — Stop Nomad Autoscale Timers (5 min)

```bash
ssh root@${CONTROL_IP} <<'ROLLBACK2'
# Stop and disable all autoscale timers
systemctl stop nomad-autoscale.timer nomad-scale-in.timer nomad-placement-failure-watcher.timer
systemctl disable nomad-autoscale.timer nomad-scale-in.timer nomad-placement-failure-watcher.timer

# Verify they are stopped
systemctl list-timers | grep nomad || echo "No Nomad timers running"
ROLLBACK2

echo "Autoscale timers stopped."
```

### Phase 3 — Drain Agent Nodes (optional, 10–30 min depending on workload)

> ⚠️ This step is optional. You can leave agent nodes running idle while the worker
> uses Docker mode — they just won't receive new work. Skip to Phase 4 if you want
> to preserve the agent node pool for a quick re-enable.

```bash
ssh root@${CONTROL_IP} <<'ROLLBACK3'
# Drain all agent (client) nodes — this gracefully migrates allocations off
for node_id in $(nomad node status -filter 'SchedulingEligibility=="eligible"' 2>/dev/null | awk 'NR>1 {print $1}'); do
  echo "Draining node: $node_id"
  nomad node drain -enable -yes "$node_id" 2>/dev/null || echo "  (already drained or server node)"
done

echo "All agent nodes draining. Wait for drain to complete, then:"
echo "  cd /opt/herobids/infra/hetzner"
echo "  terraform apply -auto-approve -var-file=production.tfvars -var=\"agent_node_count=0\""
ROLLBACK3
```

### Phase 4 — Verify Agents Work in Docker Mode

```bash
# Launch a test agent via the production web UI or API
# Then verify it appears as a local Docker container:
ssh root@${CONTROL_IP} 'docker ps --filter "label=herobids.agent"'

# Check worker logs for successful agent launch
ssh root@${CONTROL_IP} \
  'docker compose -f docker-compose.yaml -f docker-compose.prod.yaml logs --tail=30 worker | grep -E "launch|agent-"'
```

### Phase 5 — Re-Enable Nomad (when ready)

To return to Nomad orchestration after the issue is resolved:

```bash
CONTROL_IP=$(terraform output -var-file=production.tfvars -raw server_ipv4)

ssh root@${CONTROL_IP} <<'REENABLE'
cd /opt/herobids

# 1. Switch back to Nomad
sed -i 's/^RUNTIME_BACKEND=docker$/RUNTIME_BACKEND=nomad/' .env.prod
docker compose -f docker-compose.yaml -f docker-compose.prod.yaml up -d --force-recreate worker

# 2. Re-enable autoscale timers
systemctl enable --now nomad-autoscale.timer nomad-placement-failure-watcher.timer
systemctl list-timers | grep nomad

# 3. Scale agent nodes back up if they were destroyed
# cd /opt/herobids/infra/hetzner
# terraform apply -auto-approve -var-file=production.tfvars -var="agent_node_count=<desired>"

echo "Nomad re-enabled. Verify with 'nomad node status'."
REENABLE
```

---

## Troubleshooting Common Issues

| Symptom | Likely Cause | Fix |
|---|---|---|
| Worker refuses to start: `NODE_ENV=production` guard | Billing provider is `mock` in production | Set `BILLING_PRIMARY_PROVIDER=creem` (or `stripe`) in `.env.prod` |
| `terraform destroy` blocked | `prevent_destroy = true` on production server | Manually edit state: `terraform state rm <resource>` or override the lifecycle block temporarily (not recommended for production) |
| Agent launch fails: `instrument_unknown` | Venue instrument cache not populated yet | Wait up to 60 minutes for cache refresh, or restart the worker to force immediate population |
| Scale-out provisions node but it never joins | cloud-init failed or private network issue | SSH to agent node: `tail -100 /var/log/cloud-init-output.log`; check Nomad client: `systemctl status nomad` |
| Alert email not delivered in production | SMTP credentials wrong or relay unreachable | Test with `send-alert.sh --test`; check firewall allows outbound 587; verify credentials in `terraform.tfvars` |
| Worker crashes with OOM | Too many agents running in Docker mode after rollback | Scale down active agents before rollback; use Nomad mode which distributes across nodes |
| `terraform apply` times out | Hetzner API rate limit or capacity | Wait and retry; check Hetzner Cloud status page |

---

## Known Limitations

1. **Single Nomad server** — no HA quorum. If the control-plane host goes down, agent orchestration stops. Agents already running on agent nodes continue to operate independently (they don't depend on Nomad for runtime), but new agent launches, stops, and crash detection will fail until the control plane is restored.

2. **`prevent_destroy = true`** — the production control-plane server cannot be destroyed via `terraform destroy` without first editing the state to remove this lifecycle guard. This is intentional to prevent accidental deletion. The agent nodes do NOT have `prevent_destroy` and can be scaled down safely.

3. **No Nomad ACLs** — the Nomad HTTP API is unauthenticated. Any process on the private network can submit jobs, stop allocations, or drain nodes. ACLs must be configured before exposing the private network to untrusted workloads.

4. **Agent node cloud-init window** — newly provisioned agent nodes take 3–5 minutes to become ready. The autoscaler's cooldown (300s in production) accounts for this, but a surge of agent launches immediately after a scale-out may still see placement failures until the new node is ready.

5. **Terraform state on local filesystem** — no remote backend. If the control-plane host's disk is lost, Terraform state is lost. Regular backups of the `infra/hetzner/` directory (including `.terraform/` and `terraform.tfstate`) are recommended.

6. **Network CIDR collision** — if staging and production share a Hetzner project, their private network CIDRs must not overlap (staging: `10.0.0.0/16`, production: `10.1.0.0/16`). Overlapping CIDRs will cause routing failures at the Hetzner Cloud network layer.

---

## Escalation

If production orchestration fails and cannot be resolved with the troubleshooting table:

1. **Immediate action:** Roll back to Docker mode using the procedure in "Rollback to Local-Docker Runtime Mode" above. This takes < 10 minutes and restores agent functionality.

2. **Diagnose:** Collect logs before destroying evidence:
   ```bash
   ssh root@${CONTROL_IP} 'journalctl -u nomad -u nomad-autoscale -u nomad-scale-in -u nomad-placement-failure-watcher -n 500 > /tmp/nomad-debug.log'
   ssh root@${CONTROL_IP} 'tail -500 /var/log/nomad-autoscale.log > /tmp/autoscale-debug.log'
   ssh root@${CONTROL_IP} 'docker compose logs --tail=500 worker > /tmp/worker-debug.log'
   ```

3. **File a bug report** under `docs/bug-reports/2026/` with logs attached.

4. **Escalate to platform team:** [Configure in production deployment — see README.md alerting section]
