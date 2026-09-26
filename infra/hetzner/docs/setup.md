# Setup Infrastructure

## Phase 0 - Prerequisites

- **Own the domain** (or have DNS access to it): e.g. `openaidom.com`. You'll add A (and optionally AAAA records) later.

- **Install the tools** if you don't have them: `terraform`, `jq`, `python3`, `docker`, `dig`, and `pnpm`. Check with `terraform -version`, `jq --version`, etc. (macOS: `brew install terraform jq python3 docker`.)

- **Get a Hetzner Cloud API token** (Hetzner Console → Security → API Tokens). You can use one token for multiple repos, if they are in the same hetzner account/project.

- **Get AWS S3 credentials** for Terraform state: an S3 bucket name, an AWS access key + secret, and a DynamoDB table (optional but recommended) name for state locking. Multiple repos can share the same bucket/table, if they use different state keys.

- **Verify Traderton is up**: `https://api.staging.traderton.com/health/ready` or `https://api.traderton.com/health/ready` should return HTTP 200.

## Phase 1 - Environment files

- **Create the backend environment file.** Copy `infra/hetzner/.env.backend.example` → `.env.backend`, fill in the values.

- **Create .env.<staging|production> file** 

- **Point Herobids at Traderton.** In `infra/hetzner/.env.staging`, set `TRADERTON_BOUNDARY_URL=https://api.staging.traderton.com` and values for: `BOUNDARY_CONSUMER_ID`, `BOUNDARY_KEY_ID` and `BOUNDARY_SIGNING_SECRET` that match Traderton's `infra/hetzner/.env.staging`.

## Phase 2 - Generate deploy key and use in tfvars

### Step 1: Generate the SSH key pair (on your local machine)

```sh
ssh-keygen -t ed25519 -C "herobids-deploy-prod" -f ~/.ssh/herobids_deploy_key_prod -N ""
```

This creates:
- `~/.ssh/herobids_deploy_key_prod` (private — goes into production.tfvars)
- `~/.ssh/herobids_deploy_key_prod.pub` (public — goes to GitHub)

### Step 2: Add the public key to GitHub

1. Go to **GitHub → herobids repo → Settings → Deploy keys**
2. Click **Add deploy key**
3. Paste the contents of `~/.ssh/herobids_deploy_key_prod.pub`
4. Check **Allow write access** (needed for `git push` if the server needs to push back)
5. Click **Add key**

### Step 3: Add the private key to terraform.tfvars

```sh
cat ~/.ssh/herobids_deploy_key_prod
```

Copy the output and replace the placeholder in Herobids' production.tfvars:

```hcl
deploy_ssh_private_key = <<-EOT
-----BEGIN OPENSSH PRIVATE KEY-----
... (paste content here) ...
-----END OPENSSH PRIVATE KEY-----
EOT
```

Summary of what to put in Herobids' terraform.tfvars

```hcl
hcloud_token = "s2...sa"

ssh_public_key_path = "~/.ssh/herobids_deploy_key_prod.pub"  # or your actual key path

deploy_ssh_private_key = <<-EOT
-----BEGIN OPENSSH PRIVATE KEY-----
... (new herobids deploy key) ...
-----END OPENSSH PRIVATE KEY-----
EOT

git_repo_url = "git@github.com:poshjosh/herobids.git"
```

### Step 4: Set git_repo_url to SSH format

```hcl
git_repo_url = "git@github.com:poshjosh/herobids.git"
```

### Step 5: Test connectivity (optional but recommended)

```sh
ssh -i ~/.ssh/herobids_deploy_key_prod -T git@github.com
```

You should see: `Hi poshjosh/herobids! You've successfully authenticated...`

## Phase 3

- **Provision the server** `./scripts/provision.sh --env production --var-file production.tfvars`

- Read the production ip by running this in the same shell as the provision script: `terraform output -raw server_ipv4`

- Add the following to `~/.ssh/config`:

```
Host <server_ipv4>
    User root
    IdentityFile ~/.ssh/herobids_deploy_key_prod
```    

## Phase 4 - Setup Domain Records (A and AAAA)

### Check your domain `dig NS <domain> +short`

```sh
dig NS openaidom.com +short
# expected output format
# ns-2044.awsdns-63.co.uk.
# ns-457.awsdns-57.com.
# ns-867.awsdns-44.net.
# ns-1273.awsdns-31.org.
```

### Add DNS A record

Example:
- `staging.openaidom.com` → `A` → `<server_ipv4>`

Optional:
- add an `AAAA` record too if you want IPv6 and your server has a public IPv6

You do **not** need another `NS` record for `staging`.

After adding it, test with:
```sh
dig @8.8.8.8 staging.openaidom.com +short
# expected output format
# 78.46.192.37 -> staging
# 167.233.213.107 -> production
```

For AAAA record
```sh
dig @8.8.8.8 AAAA staging.openaidom.com +short
```

## Phase 5 - Verify

2. **Verify integration**: from a running Herobids container, `curl https://api.staging.traderton.com/health/ready` or `curl https://api.traderton.com/health/ready` → 200, and confirm an unsigned call returns `authentication.invalid_caller`.

## Phase 6 - Nomad ACL bootstrap (one-time, enable_nomad only)

The Nomad ACL is stored **in Nomad's data directory on the server**. A freshly
provisioned control plane has no cluster yet, so Nomad is not "bootstrapped"
and no valid management token exists. Until this is done, every authenticated
Nomad call returns `403`/`ACL token not found` and the worker cannot launch
agents.

```sh
# Clears any stale token so setup-nomad.sh actually bootstraps (see Phase 7 why this matters)
infra/hetzner/scripts/setup-nomad.sh --env <staging|production> \
  --env-file infra/hetzner/.env.<staging|production> \
  --backend-env-file infra/hetzner/.env.backend
```

`setup-nomad.sh` bootstraps the ACL, writes the token to **both** places it
must live, deploys, redeploys, and verifies:

| File | Variable | Written by setup-nomad.sh |
|------|----------|---------------------------|
| `infra/hetzner/.env.backend` | `NOMAD_ACL_TOKEN` | yes (infra / autoscale) |
| `infra/hetzner/.env.<env>` | `NOMAD_TOKEN` | yes (worker container) |

Verify the cluster is healthy **and has a placeable client node**:

```sh
ssh root@<server_ipv4> 'export NOMAD_TOKEN=$(cat /etc/nomad.d/acl-token); \
  nomad server members; nomad node status'
```

Expected: `server members` shows one `alive`, `true` leader; `node status`
shows at least one `ready` class-`agent` node. If no client node is `ready`,
bump `agent_node_count` (see Phase 7).

## Phase 7 - Teardown & re-provision (Nomad-enabled environments)

This is the path that breaks silently most often. Because the Nomad ACL lives
in on-disk state that a recreated server loses, and because the Hetzner private
NIC may not auto-configure on first boot, naive teardown → re-provision leaves
you with a crash-looping Nomad and a dead ACL token. Follow this order exactly.

### 7.1 Teardown

```sh
infra/hetzner/scripts/destroy.sh --env <staging|production> \
  --var-file infra/hetzner/<env>.tfvars \
  --backend-env-file infra/hetzner/.env.backend
```

`destroy.sh` removes servers, agent nodes, the private network, firewall, and
SSH key from the workspace state. It leaves DNS and the S3 state bucket intact.

### 7.2 Clear the Nomad token (BEFORE re-provision)

The ACL token you hold is now meaningless (the cluster it was minted for is
gone). If you re-provision with a stale non-empty token, `setup-nomad.sh` skips
bootstrap and redeploys the dead token. Clear **both** variables first:

```sh
# 1. infra variable (read by setup-nomad.sh's "already bootstrapped?" gate)
sed -i '' 's|^NOMAD_ACL_TOKEN=.*|NOMAD_ACL_TOKEN=|' infra/hetzner/.env.backend

# 2. worker variable (injected into the worker container)
sed -i '' 's|^NOMAD_TOKEN=.*|NOMAD_TOKEN=|' infra/hetzner/.env.<env>
```

> Note: the bare `infra/hetzner/.env` seen in this directory is a **vestigial
> duplicate of `.env.backend`** and is not read by any deploy script. It is safe
> to ignore; if it bothers you, delete it. The two files above are the only ones
> that matter.

### 7.3 Re-provision

```sh
infra/hetzner/scripts/provision.sh --env <staging|production> \
  --var-file infra/hetzner/<env>.tfvars \
  --backend-env-file infra/hetzner/.env.backend
```

### 7.4 Verify the private NIC came up (the reboot trap)

The Hetzner private interface (`enp7s0`) can be `DOWN`/unconfigured on first
boot, which leaves `__PRIVATE_IP__` unsubstituted in `/etc/nomad.d/nomad.hcl`
and Nomad in a crash loop. Check and, if necessary, fix it:

```sh
ssh root@<server_ipv4> 'ip -4 addr show enp7s0'
```

- If `enp7s0` has a private IPv4 (e.g. `10.0.0.2/32`) **and**
  `/etc/nomad.d/nomad.hcl` shows real IPs (not `__PRIVATE_IP__`): skip to 7.5.
- If `enp7s0` is `DOWN` / has no IPv4: reboot once

  `ssh root@<server_ipv4> 'systemctl reboot'`

  then re-check the interface **and** the `nomad.hcl` advertise block. The
  reboot brings the NIC up, but it does **not** re-substitute the placeholder
  (cloud-init's `sed` is first-boot only). If the advertise block still shows
  `__PRIVATE_IP__`, substitute it manually:

  `ssh root@<server_ipv4> 'sed -i "s/__PRIVATE_IP__/<private_ip>/g" /etc/nomad.d/nomad.hcl && systemctl restart nomad'`

### 7.5 Re-bootstrap the ACL token and agent nodes

```sh
infra/hetzner/scripts/setup-nomad.sh --env <staging|production> \
  --env-file infra/hetzner/.env.<env> \
  --backend-env-file infra/hetzner/.env.backend
```

This mint a fresh token and writes it to `.env.backend` and `.env.<env>`.

Then confirm a **client node exists** so agent jobs can be placed:

```sh
ssh root@<server_ipv4> 'export NOMAD_TOKEN=$(cat /etc/nomad.d/acl-token); nomad node status'
```

> `staging.tfvars`/`production.tfvars` set `min_agent_nodes = 0`, meaning the
> autoscaler is allowed to drain to zero. A re-provision does **not** by itself
> create a client node unless `agent_node_count >= 1` at apply time. If no
> `ready` agent node appears, restore one with:

```sh
infra/hetzner/scripts/provision.sh --env <staging|production> \
  --var-file infra/hetzner/<env>.tfvars \
  --backend-env-file infra/hetzner/.env.backend
# and set agent_node_count >= 1 in <env>.tfvars (or scale-out.sh)
```

### 7.6 Final verification

```sh
ssh root@<server_ipv4> 'export NOMAD_TOKEN=$(cat /etc/nomad.d/acl-token); \
  nomad server members && nomad node status'
```

All green when: leader `alive`, ≥1 `ready` agent node, and the worker logs no
`runtime.launch_failed` when you start an agent.

### 7.7 Verify worker → Nomad reachability (the firewall trap)

The worker/API containers live on the **local Docker bridge**, not the Hetzner
private network, so their Nomad traffic is subject to UFW's routed-default-deny.
If it is blocked, agents fail with `Critical execution failure` (worker logs
`runtime.launch_failed: This operation was aborted`) even though Nomad itself is
healthy. Confirm from inside the worker container:

```sh
ssh root@<server_ipv4> 'docker exec herobids-worker-1 \
  sh -c "wget -qO- --timeout=5 http://10.0.0.2:4646/v1/status/leader"'
```

Expected: `"10.0.0.2:4647"` (the leader addr), **not** `download timed out`.
The bridge→Nomad allow rules are pinned in `cloud-init.yaml` (ports 4646/4647/4648
from `172.18.0.0/16`) and the bridge subnet is pinned in `docker-compose.yaml`
(`networks.default.ipam`). If this check fails, re-apply:

```sh
ssh root@<server_ipv4> 'ufw allow from 172.18.0.0/16 to any port 4646 proto tcp && \
  ufw allow from 172.18.0.0/16 to any port 4647 proto tcp && \
  ufw allow from 172.18.0.0/16 to any port 4648 proto tcp'
```

> **Private-IP drift caveat:** `.env.staging` / `.env.production` hardcode
> `NOMAD_ADDR` and `SHARED_REDIS_HOST` / `SHARED_POSTGRES_HOST` to a fixed private
> IP (e.g. `10.0.0.2`), while `cloud-init.yaml` resolves the private IP dynamically
> at first boot. If a re-provision ever lands a different private IP, the hardcoded
> values will break silently. After any re-provision, confirm the values in
> `.env.<env>` still match the actual control-plane private IP (`ip -4 addr show enp7s0`).

### 7.8 Verify the agent image can be pulled on the client node

Agent jobs run on Nomad client nodes (not the control plane) and pull
`ghcr.io/poshjosh/herobids-agent:latest`. If the image is not published (the
`.github/workflows/build-push-agent.yml` CI run has not pushed it) or the client
node cannot authenticate, every agent launch fails with `Stale agent start
detected` (health monitor) → "Critical execution failure", even though the job
registers and places.

```sh
# From the control plane, reach the agent node (10.0.0.3 = agent-1 private IP):
ssh root@<server_ipv4> 'ssh -i /root/.ssh/deploy_key root@10.0.0.3 '\''docker pull ghcr.io/poshjosh/herobids-agent:latest'\'''
```

Expected: the pull succeeds. If it fails with `denied`, the client node has not
logged into ghcr.io — set `ghcr_username`/`ghcr_token` in `<env>.tfvars` and
re-provision that node (cloud-init runs `docker login ghcr.io` on boot). If it
fails with `not found`, the CI workflow hasn't pushed the image yet.
