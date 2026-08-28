# Staging Orchestration Runbook

> **Superseded by:** infra/hetzner/docs/auto-scaling/setup-auto-scaling.md

> **Feature:** 004-orchestration (Phases 1–9)
> **Environment:** Staging (`NODE_ENV=staging`, `HEROBIDS_ENV=staging`)
> **Last updated:** 2026-07-08

Companion to `docs/runbooks/staging-smoke-test.md`. This runbook covers Nomad-based agent orchestration validation — agent launch/stop/crash, autoscaling, alerting, and rollback.

---

## Pre-requisites

Before starting, confirm:

1. **Staging control plane is healthy.** Run the base smoke test at `docs/runbooks/staging-smoke-test.md` first. API, web, Caddy, worker must all be green.

2. **Nomad is provisioned and enabled.** From your local machine:

   ```bash
   cd infra/hetzner
   terraform output -var-file=staging.tfvars nomad_enabled
   # Expected: true
   ```

3. **At least 1 agent node is provisioned:**

   ```bash
   terraform output -var-file=staging.tfvars agent_node_count
   # Expected: >= 1
   ```

4. **You can SSH to the control plane and agent nodes:**

   ```bash
   terraform output -var-file=staging.tfvars ssh_command
   terraform output -var-file=staging.tfvars agent_ssh_commands
   ```

5. **Worker is configured to use the Nomad backend.** The staging `.env` (or compose overlay) must include:

   ```bash
   RUNTIME_BACKEND=nomad
   NOMAD_ADDR=http://<control-plane-private-ip>:4646
   SHARED_REDIS_HOST=<control-plane-private-ip>
   SHARED_POSTGRES_HOST=<control-plane-private-ip>
   ```

   The control plane private IP is available from Terraform:

   ```bash
   terraform output -var-file=staging.tfvars control_plane_private_ip
   ```

6. **Alerting SMTP is configured (optional but recommended).** Test with:

   ```bash
   ssh $(terraform output -var-file=staging.tfvars -raw server_ipv4) \
     '/opt/herobids/infra/hetzner/scripts/send-alert.sh --test --dry-run'
   ```

---

## Environment-Specific Defaults

| Variable | Staging Value |
|---|---|
| `HEROBIDS_ENV` | `staging` |
| `network_ip_range` | `10.0.0.0/16` |
| `subnet_ip_range` | `10.0.0.0/24` |
| `server_name` | `herobids-staging` |
| `nomad_version` | `1.9.7` |
| `agent_node_server_type` | `cpx21` (2 vCPU, 4 GB) |
| `agent_memory_reservation_mb` | `256` |
| `min_agent_nodes` | `1` |
| `max_agent_nodes` | `5` |
| `scale_out_cooldown_seconds` | `120` |
| `scale_out_memory_threshold_pct` | `30` |
| `scale_out_slot_threshold` | `2` |
| `scale_out_increment` | `1` |
| `enable_scale_in` | `false` (enable manually for testing) |
| `scale_in_time_utc` | `"3"` |
| `alert_failure_threshold` | `3` |
| `alert_rate_limit_seconds` | `3600` |
| `placement_failure_window_seconds` | `300` |
| `placement_failure_threshold` | `5` |
| `placement_failure_cooldown_seconds` | `600` |
| `prevent_destroy` (Terraform) | `false` — staging can be torn down freely |

---

## Step 1 — Provision the Staging Orchestration Cluster

If not already done, provision from scratch:

```bash
cd infra/hetzner

# Copy and edit the staging tfvars
cp staging.tfvars.example staging.tfvars
# Edit: fill in hcloud_token, ssh_public_key_path, deploy_ssh_private_key,
#       git_repo_url, agent_node_count (set to 1 or more), SMTP vars if desired.

# Provision
./scripts/provision.sh --env staging --var-file staging.tfvars

# Verify outputs
terraform output -var-file=staging.tfvars
```

Wait 3–5 minutes for cloud-init to complete on all nodes. The `final_message` in cloud-init output indicates completion.

---

## Step 2 — Configure the Worker for Nomad

The worker needs `RUNTIME_BACKEND=nomad` and cluster-safe shared-service addresses. Add these to the staging `.env` file:

```bash
CONTROL_PLANE_IP=$(terraform output -var-file=staging.tfvars -raw control_plane_private_ip)

ssh root@$(terraform output -var-file=staging.tfvars -raw server_ipv4) <<EOF
cat >> /opt/herobids/.env.staging <<ENV

# Nomad orchestration (Phase 4)
RUNTIME_BACKEND=nomad
NOMAD_ADDR=http://${CONTROL_PLANE_IP}:4646

# Cluster-safe shared services (Phase 3)
SHARED_REDIS_HOST=${CONTROL_PLANE_IP}
SHARED_POSTGRES_HOST=${CONTROL_PLANE_IP}
ENV
EOF
```

Restart the worker to pick up the new env:

```bash
ssh root@$(terraform output -var-file=staging.tfvars -raw server_ipv4) \
  'cd /opt/herobids && docker compose -f docker-compose.yaml -f docker-compose.staging.yaml up -d --force-recreate worker'
```

Check worker logs to confirm Nomad backend is active:

```bash
ssh root@$(terraform output -var-file=staging.tfvars -raw server_ipv4) \
  'docker compose -f docker-compose.yaml -f docker-compose.staging.yaml logs --tail=30 worker | grep -E "Runtime backend|nomad"'
```

Expected output: `Runtime backend: nomad`.

---

## Step 3 — Validate Cluster Health

```bash
CONTROL_IP=$(terraform output -var-file=staging.tfvars -raw server_ipv4)

# Nomad server members
ssh root@${CONTROL_IP} 'nomad server members'
# Expected: 1 server, alive, leader

# Nomad client nodes
ssh root@${CONTROL_IP} 'nomad node status'
# Expected: 1+ client nodes, all "ready"

# Nomad node detail (check resources)
ssh root@${CONTROL_IP} 'nomad node status -verbose'
# Confirm each node has the expected memory/cpu

# Agent node cloud-init completed successfully
AGENT_IP=$(terraform output -var-file=staging.tfvars -json agent_node_public_ips | jq -r '.[0]')
ssh root@${AGENT_IP} 'tail -20 /var/log/cloud-init-output.log'
# Expected: "Cloud-init complete"

# Private network connectivity: agent node → Postgres
ssh root@${AGENT_IP} "nc -zv \$(awk '/nameserver/{print \$2; exit}' /etc/resolv.conf) 5432 2>&1 || echo 'Postgres reachability check attempted'"
```

---

## Step 4 — Agent Launch Through Nomad

### 4.1 Launch an agent via the API

Use the staging web UI or API to create a new agent. If using the API:

```bash
STAGING_API="https://staging.openaidom.com/api"

# Create a test agent (requires auth token)
curl -s -X POST "${STAGING_API}/agents" \
  -H "Authorization: Bearer ${AUTH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "orchestration-smoke-test",
    "type": "trading",
    "connectionId": "<connection-id>",
    "planId": "<plan-id>"
  }' | jq .
```

### 4.2 Verify Nomad allocates the agent

```bash
ssh root@${CONTROL_IP} 'nomad job status'
# Expected: a job named "agent-<agent-id>" with status "running"

# Check allocation details
ssh root@${CONTROL_IP} 'nomad alloc status -namespace=herobids-agents'
# Expected: allocation is "running", shows the node it landed on

# Check the agent container is running on the assigned node
ALLOC_NODE=$(ssh root@${CONTROL_IP} "nomad alloc status -namespace=herobids-agents -json" | jq -r '.[0].NodeName')
ssh root@${CONTROL_IP} "nomad node status ${ALLOC_NODE}"
```

### 4.3 Verify agent connectivity

Check agent logs for successful Redis/Postgres connection:

```bash
# Find the allocation ID
ALLOC_ID=$(ssh root@${CONTROL_IP} "nomad job allocs -namespace=herobids-agents -json" | jq -r '.[0].ID')

# Stream agent logs (on the node where it landed)
ssh root@${CONTROL_IP} "nomad alloc logs -namespace=herobids-agents ${ALLOC_ID}"
# Expected: agent connects to Redis and Postgres without errors
```

### 4.4 Verify the worker sees the agent

```bash
ssh root@${CONTROL_IP} \
  'docker compose -f docker-compose.yaml -f docker-compose.staging.yaml logs --tail=50 worker | grep "agent-"'
# Expected: agent lifecycle events (launched, session started, etc.)
```

---

## Step 5 — Agent Stop

### 5.1 Stop the agent via the API

```bash
AGENT_ID="<agent-id-from-step-4>"

curl -s -X POST "${STAGING_API}/agents/${AGENT_ID}/stop" \
  -H "Authorization: Bearer ${AUTH_TOKEN}" | jq .
```

### 5.2 Verify Nomad job is stopped

```bash
ssh root@${CONTROL_IP} "nomad job status agent-${AGENT_ID}"
# Expected: "No job(s) with prefix or id"
# Or: job status "dead"
```

### 5.3 Verify worker classifies it correctly

```bash
ssh root@${CONTROL_IP} \
  'docker compose -f docker-compose.yaml -f docker-compose.staging.yaml logs --tail=50 worker | grep -E "stop|stopped"'
# Expected: agent status transitions to "stopped", NOT "crashed"
```

---

## Step 6 — Crash Detection

### 6.1 Force-kill an agent container

```bash
# Find the allocation ID of a running agent
ALLOC_ID=$(ssh root@${CONTROL_IP} "nomad job allocs -namespace=herobids-agents -json" | jq -r '.[0].ID')

# Force-stop the allocation (simulates a crash)
ssh root@${CONTROL_IP} "nomad alloc stop -namespace=herobids-agents ${ALLOC_ID}"
```

### 6.2 Verify crash detection

```bash
# Wait ~30 seconds (terminationPollIntervalMs), then check worker logs
sleep 35
ssh root@${CONTROL_IP} \
  'docker compose -f docker-compose.yaml -f docker-compose.staging.yaml logs --tail=100 worker | grep -E "crash|terminat|unexpected"'
# Expected: worker detects the allocation stopped, classifies it as a crash,
#           not a voluntary stop
```

### 6.3 Verify agent status in API

```bash
curl -s "${STAGING_API}/agents/${AGENT_ID}" \
  -H "Authorization: Bearer ${AUTH_TOKEN}" | jq '.status'
# Expected: "crashed" or equivalent terminal status
```

---

## Step 7 — Reconciliation After Worker Restart

### 7.1 Launch 2 test agents, then restart the worker

```bash
# Launch agents (as in Step 4)

# Restart the worker
ssh root@${CONTROL_IP} \
  'cd /opt/herobids && docker compose -f docker-compose.yaml -f docker-compose.staging.yaml restart worker'
```

### 7.2 Verify reconciliation

```bash
# Wait for worker to boot and run reconciliation
sleep 15

# Check worker logs for reconciliation activity
ssh root@${CONTROL_IP} \
  'docker compose -f docker-compose.yaml -f docker-compose.staging.yaml logs --tail=100 worker | grep -i reconcile'
# Expected: worker enumerates Nomad allocations, compares against desired state,
#           reconciles any discrepancies

# Verify agent statuses are correct post-reconciliation
ssh root@${CONTROL_IP} 'nomad job status -namespace=herobids-agents'
# Expected: running agents from before restart are still running
```

---

## Step 8 — Scale-Out Under Synthetic Pressure

### 8.1 Check current capacity

```bash
ssh root@${CONTROL_IP} '/opt/herobids/infra/hetzner/scripts/check-nomad-capacity.sh'
# Note: free_memory_mb, free_slots, memory_pct_free
```

### 8.2 Force a scale-out (bypass thresholds)

```bash
ssh root@${CONTROL_IP} '/opt/herobids/infra/hetzner/scripts/scale-out.sh --force'
```

### 8.3 Verify new node was provisioned

```bash
# Check Nomad nodes — should see one more
ssh root@${CONTROL_IP} 'nomad node status'

# Check Terraform state
ssh root@${CONTROL_IP} 'cd /opt/herobids/infra/hetzner && terraform state list | grep hcloud_server.agent'

# Check autoscale log
ssh root@${CONTROL_IP} 'tail -20 /var/log/nomad-autoscale.log'
```

### 8.4 Verify new node joins the cluster

Wait 3–5 minutes for cloud-init on the new node, then:

```bash
ssh root@${CONTROL_IP} 'nomad node status'
# Expected: the new node appears with status "ready"

# Confirm the node has the correct metadata
ssh root@${CONTROL_IP} 'nomad node status -verbose <new-node-id>'
# Expected: meta.environment = "staging", meta.node_pool = "herobids-staging"
```

### 8.5 Test with a dry-run first

```bash
# Dry-run to preview what WOULD happen
ssh root@${CONTROL_IP} '/opt/herobids/infra/hetzner/scripts/scale-out.sh --dry-run'

# Check the autoscale timer is running
ssh root@${CONTROL_IP} 'systemctl status nomad-autoscale.timer'
ssh root@${CONTROL_IP} 'systemctl list-timers nomad-autoscale.timer'
```

---

## Step 9 — Nightly Scale-In Behavior

### 9.1 Enable scale-in for staging

```bash
# Enable via env var override (temporary for testing)
ssh root@${CONTROL_IP} \
  'ENABLE_SCALE_IN=true /opt/herobids/infra/hetzner/scripts/scale-in.sh --dry-run'
```

### 9.2 Manual scale-in test (with dry-run first)

```bash
# Dry-run: shows which nodes would be drained
ssh root@${CONTROL_IP} \
  'ENABLE_SCALE_IN=true NOMAD_SCALE_IN_MAX_NODES_PER_RUN=1 /opt/herobids/infra/hetzner/scripts/scale-in.sh --dry-run'

# Execute scale-in (only removes idle nodes)
ssh root@${CONTROL_IP} \
  'ENABLE_SCALE_IN=true NOMAD_SCALE_IN_MAX_NODES_PER_RUN=1 /opt/herobids/infra/hetzner/scripts/scale-in.sh'
```

### 9.3 Verify active agents are NOT evicted

```bash
# Before scale-in: launch an agent and note which node it lands on
# After scale-in: confirm that node is still present and the agent is still running
ssh root@${CONTROL_IP} 'nomad job status -namespace=herobids-agents'
# Expected: all agents still running, no evictions

# If agents were on idle nodes, the scale-in script should have SKIPPED those nodes
ssh root@${CONTROL_IP} 'tail -30 /var/log/nomad-autoscale.log | grep -i skip'
```

### 9.4 Check systemd timer status (if permanent enable desired)

```bash
ssh root@${CONTROL_IP} 'systemctl status nomad-scale-in.timer'
# If you want permanent enable:
# ssh root@${CONTROL_IP} 'systemctl enable --now nomad-scale-in.timer'
```

---

## Step 10 — Alert Email Delivery

### 10.1 Test alert delivery

```bash
# Dry-run first (preview content, no send)
ssh root@${CONTROL_IP} '/opt/herobids/infra/hetzner/scripts/send-alert.sh --test --dry-run'

# Send test alert
ssh root@${CONTROL_IP} '/opt/herobids/infra/hetzner/scripts/send-alert.sh --test'

# Check syslog for fallback logging (if SMTP not configured)
ssh root@${CONTROL_IP} 'journalctl -t nomad-autoscale-alert -n 10'
```

### 10.2 Simulate failure streak and verify alert

```bash
# Manually set failure count to trigger threshold
ssh root@${CONTROL_IP} 'echo "3" > /var/run/nomad-autoscale-failure-count'

# Run scale-out which will fail (e.g., point NOMAD_ADDR to a bad host)
ssh root@${CONTROL_IP} 'NOMAD_ADDR=http://127.0.0.1:1 /opt/herobids/infra/hetzner/scripts/scale-out.sh || true'

# Check if alert was triggered
ssh root@${CONTROL_IP} 'journalctl -t nomad-autoscale-alert -n 20'
# Expected: alert sent (or logged if SMTP not configured)

# Reset failure count
ssh root@${CONTROL_IP} 'echo "0" > /var/run/nomad-autoscale-failure-count'
```

### 10.3 Verify rate limiting

```bash
# Check last alert timestamp
ssh root@${CONTROL_IP} 'cat /var/run/nomad-autoscale-last-alert'

# Trigger another failure within the rate limit window
ssh root@${CONTROL_IP} 'echo "3" > /var/run/nomad-autoscale-failure-count'
ssh root@${CONTROL_IP} 'NOMAD_ADDR=http://127.0.0.1:1 /opt/herobids/infra/hetzner/scripts/scale-out.sh || true'

# Check logs — should show "rate limited" skip
ssh root@${CONTROL_IP} 'journalctl -t nomad-autoscale-alert -n 10 | grep -i "rate.limit\|skipping"'

# Reset
ssh root@${CONTROL_IP} 'echo "0" > /var/run/nomad-autoscale-failure-count'
```

---

## Step 11 — Placement-Failure Safety Net

### 11.1 Check safety net watcher status

```bash
ssh root@${CONTROL_IP} 'systemctl status nomad-placement-failure-watcher.timer'
ssh root@${CONTROL_IP} 'systemctl status nomad-placement-failure-watcher.service'
```

### 11.2 Dry-run the safety net check

```bash
ssh root@${CONTROL_IP} '/opt/herobids/infra/hetzner/scripts/check-placement-failures.sh --dry-run'
```

### 11.3 Verify safety-net state file

```bash
ssh root@${CONTROL_IP} 'cat /var/run/nomad-placement-failure-state'
```

---

## Manual Fallback Procedures

### If Nomad is unhealthy

1. **Check Nomad server status:**

   ```bash
   ssh root@${CONTROL_IP} 'systemctl status nomad'
   ssh root@${CONTROL_IP} 'nomad server members'
   ```

2. **Restart Nomad server:**

   ```bash
   ssh root@${CONTROL_IP} 'systemctl restart nomad'
   # Wait 10s for leader election
   ssh root@${CONTROL_IP} 'nomad server members'
   ```

3. **Agent node not joining cluster:**

   ```bash
   ssh root@<agent-ip> 'systemctl status nomad'
   ssh root@<agent-ip> 'tail -50 /var/log/cloud-init-output.log'
   ssh root@<agent-ip> 'nomad node status -self'
   ```

### If autoscale loop is unhealthy

1. **Check service/timer status:**

   ```bash
   ssh root@${CONTROL_IP} 'systemctl status nomad-autoscale.service'
   ssh root@${CONTROL_IP} 'systemctl list-timers'
   ```

2. **Check for Terraform lock:**

   ```bash
   ssh root@${CONTROL_IP} 'cd /opt/herobids/infra/hetzner && terraform force-unlock <LOCK_ID>'
   ```

3. **Manual scale-out (bypass autoscaler):**

   ```bash
   ssh root@${CONTROL_IP} 'cd /opt/herobids/infra/hetzner && terraform apply -auto-approve -var-file=staging.tfvars -var="agent_node_count=<N+1>"'
   ssh root@${CONTROL_IP} 'echo "<N+1>" > /var/run/nomad-autoscale-node-count'
   ```

4. **Check autoscale logs:**

   ```bash
   ssh root@${CONTROL_IP} 'tail -100 /var/log/nomad-autoscale.log'
   ssh root@${CONTROL_IP} 'journalctl -u nomad-autoscale -u nomad-scale-in -u nomad-placement-failure-watcher -n 100'
   ```

### Full manual placement (Nomad dead, no worker Nomad adapter)

If the Nomad backend is completely broken and you need to launch agents NOW:

```bash
# Switch to Docker backend temporarily
ssh root@${CONTROL_IP} <<'EOF'
cd /opt/herobids

# Override RUNTIME_BACKEND in the worker service
# Option A: Edit .env.staging and restart
sed -i 's/^RUNTIME_BACKEND=nomad$/RUNTIME_BACKEND=docker/' .env.staging
docker compose -f docker-compose.yaml -f docker-compose.staging.yaml up -d --force-recreate worker

# Option B: Use env var override in compose
# Add to docker-compose.staging.yaml under worker.environment:
#   RUNTIME_BACKEND: docker
EOF
```

Agents will now launch as local Docker containers on the control-plane host.

---

## Rollback to Local-Docker Runtime Mode

To revert the entire orchestration stack back to the pre-Nomad single-host model:

### 1. Switch worker to Docker backend

```bash
ssh root@${CONTROL_IP} <<'EOF'
cd /opt/herobids
sed -i 's/^RUNTIME_BACKEND=nomad$/RUNTIME_BACKEND=docker/' .env.staging
docker compose -f docker-compose.yaml -f docker-compose.staging.yaml up -d --force-recreate worker
EOF
```

### 2. Stop all Nomad timers

```bash
ssh root@${CONTROL_IP} <<'EOF'
systemctl stop nomad-autoscale.timer nomad-scale-in.timer nomad-placement-failure-watcher.timer
systemctl disable nomad-autoscale.timer nomad-scale-in.timer nomad-placement-failure-watcher.timer
EOF
```

### 3. Drain and destroy agent nodes (optional — or leave them for later)

```bash
# SSH to control plane
ssh root@${CONTROL_IP}

# Drain all agent nodes
for node in $(nomad node status -filter 'SchedulingEligibility=="eligible"' 2>/dev/null | awk 'NR>1 {print $1}'); do
  nomad node drain -enable -yes "$node" 2>/dev/null || true
done

# Scale agent_node_count to 0 via Terraform
cd /opt/herobids/infra/hetzner
terraform apply -auto-approve -var-file=staging.tfvars -var="agent_node_count=0"
```

### 4. Verify agents work in Docker mode

Launch a test agent via the web UI or API. It should appear as a local Docker container:

```bash
ssh root@${CONTROL_IP} 'docker ps --filter "label=herobids.agent"'
```

---

## Troubleshooting Common Issues

| Symptom | Likely Cause | Fix |
|---|---|---|
| Worker fails to start: `nomad.addr is required` | `RUNTIME_BACKEND=nomad` is set but `NOMAD_ADDR` is missing | Set `NOMAD_ADDR=http://<control-plane-private-ip>:4646` in `.env.staging` |
| Agent launch hangs, no Nomad job created | Worker can't reach Nomad API | Check `NOMAD_ADDR` is correct; verify private network connectivity: `nc -zv <ip> 4646` |
| Agent launches but crashes: Postgres connection refused | Agent can't reach shared services | Verify `SHARED_REDIS_HOST` / `SHARED_POSTGRES_HOST` are set to the control-plane private IP; check UFW: `ufw status` |
| `terraform apply` fails: lock held | Previous operation interrupted | `terraform force-unlock <LOCK_ID>` from the control plane |
| Scaled-out node never joins cluster | cloud-init failed or retry_join exhausted | SSH to the agent node: `tail -100 /var/log/cloud-init-output.log`; check Nomad client status: `systemctl status nomad` |
| Scale-in drained a node with active agents | Node had system allocations, not agent allocations. Safe — those are rescheduled | Check `nomad node status <node>`; if user agents were evicted, file a bug report |
| Alert email not delivered | SMTP not configured or sendmail missing | Verify `bsd-mailx` is installed; test with `send-alert.sh --test --dry-run`; check `journalctl -t nomad-autoscale-alert` |
| `prevent_destroy` blocks `terraform destroy` | Terraform lifecycle block (production only; staging is unaffected) | In staging: not applicable (`prevent_destroy = false`). In production: manually remove the lifecycle block from state before destroy. |
| `terraform destroy` fails on network resources | Hetzner Cloud requires network detachment before deletion | Detach servers from the private network first, then retry `terraform destroy` |

---

## Known Limitations

1. **Single Nomad server per environment** — no HA quorum. If the control-plane host goes down, agent orchestration stops. This is acceptable for the initial target (200–2000 agents). HA Nomad (3–5 servers) is deferred follow-up work.

2. **`prevent_destroy` blocks teardown in production** — the control-plane server has `prevent_destroy = true`. To destroy production, you must first edit the Terraform state to remove this lifecycle guard. This is by design to prevent accidental deletion.

3. **No Nomad ACLs** — the Nomad HTTP API is open to any process on the private network. ACLs should be configured before exposing Nomad to less-trusted networks. Tracked as a follow-up task (see cloud-init TODO comment).

4. **Agent node cloud-init must complete before agent placement** — newly provisioned nodes take 3–5 minutes to join the cluster. Agents launched during this window will be placed on existing nodes. If all existing nodes are at capacity, placement will fail until the new node joins.

5. **Terraform local state** — the autoscaler uses local Terraform state on the control-plane filesystem. There is no remote state backend. If the control-plane host is lost, Terraform state is lost. Consider migrating to a remote backend (S3, Terraform Cloud) for production resilience.

---

## Escalation

If validation fails and the issue cannot be resolved with the troubleshooting table above:

1. Check the autoscale unified log: `journalctl -u nomad-autoscale -u nomad-scale-in -u nomad-placement-failure-watcher -n 200`
2. Check the worker logs: `docker compose logs --tail=200 worker`
3. Check Nomad server logs: `journalctl -u nomad -n 200`
4. File a bug report under `docs/bug-reports/2026/` with the logs attached
5. Contact the platform team via [Configure in production deployment — see README.md alerting section]
