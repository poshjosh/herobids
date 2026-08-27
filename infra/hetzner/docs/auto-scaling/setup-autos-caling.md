## Steps to Enable and Provision Nomad for Staging

### Step 1 — Push your latest commits to remote

The control-plane server clones from `git_repo_url` during provisioning/deploy, so the remote branch needs your latest code.

```bash
git push
```

### Step 2 — Uncomment and set Nomad-related variables in `staging.tfvars`

Edit `infra/hetzner/staging.tfvars` and uncomment these lines:

```hcl
# Nomad Orchestration
enable_nomad = true
nomad_version = "1.9.7"

# Agent Node Pool — start with 0 node
agent_node_count       = 0
min_agent_nodes        = 0
max_agent_nodes        = 3
agent_node_server_type = "cpx21"
```

Leave the autoscale, scale-in, placement-failure, and alerting defaults commented out for now — their defaults from `variables.tf` are sensible. You can tune them later.

### Step 3 — Select the staging Terraform workspace

```bash
cd infra/hetzner
terraform workspace select staging
```

Verify you're on the right workspace:
```bash
terraform workspace show
# Expected: staging
```

### Step 4 — Run `terraform plan` to preview changes

In `infra/hetzner/main.tf` set prevent_destroy to `false`, then commit and push.

```
resource "hcloud_server" "default" {
  // REMAINING CODE OMITTED FOR BREVITY  
  lifecycle {
    prevent_destroy = false
  }
}
```

Then run:

```bash
terraform plan -var-file=staging.tfvars
```

Review the output. You should see it creating:
- `hcloud_network.private[0]` — the private network
- `hcloud_network_subnet.private[0]` — the subnet
- `hcloud_server_network.control_plane[0]` — attaching the control-plane to the private network
- `hcloud_firewall.agent[0]` — agent node firewall
- `hcloud_server.agent[0]` — 1 agent node
- `hcloud_server_network.agent[0]` — attaching the agent to the private network

If the control-plane server already exists, Terraform may want to **replace** it (because `user_data` changed — cloud-init includes all the Nomad config). This would be destructive. Check the plan carefully:
- If it says `must be replaced` for `hcloud_server.default`, that's expected but means downtime. The `prevent_destroy = true` lifecycle will actually **block** this — you'll get an error. In that case, you'd need to deploy without recreating the server and instead SSH in to configure Nomad manually, or use the provision script.

### Step 5 — Apply (if plan looks clean)

If the plan only adds new resources (network, agent node) without replacing the control plane: (this would be the case when user_data hasn't changed — meaning no cloud-init template variables were added or modified since the last apply)

```bash
terraform apply -var-file=staging.tfvars
```

If the plan wants to replace the control-plane server, use the provision script instead which handles this more gracefully:

```bash
./scripts/provision.sh --env staging --var-file staging.tfvars
```

### Step 6 — Wait for cloud-init (3–5 minutes)

The new agent node needs time to boot, install Docker and Nomad, and join the cluster. 

If need, use the below to wait:

assuming ip = 128.140.55.192

```bash
ssh -i ~/.ssh/herobids_deploy_key root@128.140.55.192 'tail -f /var/log/cloud-init-output.log'
```

If the above leads to something like: "WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED"

Then run `ssh-keygen -R 128.140.55.192`. After which re-run the above script.

Alternatively:

```bash
# Get the control-plane IP
terraform output -var-file=staging.tfvars

# Check agent node cloud-init progress
AGENT_IP=$(terraform output -json agent_node_public_ips | jq -r '.[0]')
ssh -i ~/.ssh/herobids_deploy_key root@${AGENT_IP} 'tail -f /var/log/cloud-init-output.log'
# Wait until you see "Cloud-init complete"
```

### Step 7 — Configure the worker for Nomad backend

This follows the runbook Step 2. Get the control-plane private IP and set the worker env:

If the control plane ip=10.0.0.2, update `infra/hetzner/.env.staging`:

```
# Nomad orchestration
RUNTIME_BACKEND=nomad
NOMAD_ADDR=http://10.0.0.2:4646
SHARED_REDIS_HOST=10.0.0.2
SHARED_POSTGRES_HOST=10.0.0.2
```

Alternatively:

```bash
CONTROL_PLANE_IP=$(terraform output -raw control_plane_private_ip)
SERVER_IP=$(terraform output -raw server_ipv4)

ssh root@${SERVER_IP} <<EOF
cat >> /opt/herobids/.env.staging <<ENV

# Nomad orchestration
RUNTIME_BACKEND=nomad
NOMAD_ADDR=http://${CONTROL_PLANE_IP}:4646
SHARED_REDIS_HOST=${CONTROL_PLANE_IP}
SHARED_POSTGRES_HOST=${CONTROL_PLANE_IP}
ENV
EOF
```

Alternatively, the below will update the env file and re-start the working, so that Step 8 below would also have been done:

```bash
infra/hetzner/deploy.sh --env staging --env-file infra/hetzner/.env.staging
```

### Step 8 — Restart the worker

In `infra/hetzner/main.tf` set prevent_destroy to `true`, the commit and push.

```
resource "hcloud_server" "default" {
  // REMAINING CODE OMITTED FOR BREVITY  
  lifecycle {
    prevent_destroy = false
  }
}
```

Restart the worker

```bash
ssh root@${SERVER_IP} \
  'cd /opt/herobids && docker compose -f docker-compose.yaml -f docker-compose.staging.yaml up -d --force-recreate worker'
```

### Step 9 — Verify

assuming server ip = 128.140.55.192

```bash
# Worker should report "Runtime backend: nomad"
ssh -i ~/.ssh/herobids_deploy_key root@128.140.55.192 \
  'docker compose -f docker-compose.yaml -f docker-compose.staging.yaml logs --tail=30 worker | grep -E "Runtime backend|nomad"'

# Nomad server should be alive
ssh -i ~/.ssh/herobids_deploy_key root@128.140.55.192 'nomad server members'

# Agent node should be "ready"
ssh -i ~/.ssh/herobids_deploy_key root@128.140.55.192 'nomad node status'
```


### Step 10 - Smoke Tests

Once all three checks pass, you're ready to run the 11-step validation checklist from the runbook (Steps 3–11).

See: `docs/runbooks/smoke-test-staging.md`

### Important note on the `prevent_destroy` lifecycle

Your `hcloud_server.default` has `prevent_destroy = true`. If Terraform wants to recreate the control-plane (because cloud-init user_data changed), it will error. You have two options:

1. **Preferred**: Don't recreate. SSH into the existing server and install Nomad manually (or re-run the deploy script which pulls latest code).
2. **Nuclear**: Temporarily remove the lifecycle guard, apply, then re-add it. This destroys and recreates the server — full downtime.