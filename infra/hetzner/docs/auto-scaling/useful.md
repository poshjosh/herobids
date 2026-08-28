# Useful Commands — Nomad Staging

Quick-reference commands for operating the Nomad staging cluster.

Server IP and agent node IPs change on recreation. Always check first:
```bash
cd infra/hetzner
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

```bash
# Server members (should advertise 10.0.0.x, NOT 172.17.x.x)
ssh -i ~/.ssh/herobids_deploy_key root@<server-ip> 'nomad server members'

# Client nodes (should show "ready" / "eligible")
ssh -i ~/.ssh/herobids_deploy_key root@<server-ip> 'nomad node status'

# Running jobs
ssh -i ~/.ssh/herobids_deploy_key root@<server-ip> 'nomad job status -namespace=herobids-agents'
```

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

```bash
# Check cluster capacity
ssh -i ~/.ssh/herobids_deploy_key root@<server-ip> '/opt/herobids/infra/hetzner/scripts/check-nomad-capacity.sh'

# Force scale-out (bypass thresholds)
ssh -i ~/.ssh/herobids_deploy_key root@<server-ip> '/opt/herobids/infra/hetzner/scripts/scale-out.sh --force'

# Dry-run scale-out
ssh -i ~/.ssh/herobids_deploy_key root@<server-ip> '/opt/herobids/infra/hetzner/scripts/scale-out.sh --dry-run'

# Dry-run scale-in (must enable explicitly)
ssh -i ~/.ssh/herobids_deploy_key root@<server-ip> \
  'ENABLE_SCALE_IN=true /opt/herobids/infra/hetzner/scripts/scale-in.sh --dry-run'

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
ssh -i ~/.ssh/herobids_deploy_key root@<agent-ip> 'nc -zv 10.0.0.2 4647'

# Restart Nomad on agent node
ssh -i ~/.ssh/herobids_deploy_key root@<agent-ip> 'systemctl restart nomad'
```
