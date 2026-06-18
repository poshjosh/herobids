# Hetzner Deployment — Herobids

Production deployment of Herobids on a Hetzner Cloud VPS (CPX22, Ubuntu 24.04).

## Directory Structure

```
infra/hetzner/
├── main.tf                    # Terraform: server, firewall, SSH key
├── variables.tf               # Terraform: input variables
├── outputs.tf                 # Terraform: output values (IPs, URLs, SSH command)
├── cloud-init.yaml            # First-boot provisioning (Docker, UFW, git clone, backups)
├── terraform.tfvars.example   # Template for terraform variables
├── deploy.sh                  # Full deploy orchestrator (env → push → seed → verify)
├── README.md                  # This file
└── scripts/
    ├── provision.sh           # Terraform init + apply
    ├── push.sh                # Deploy latest code to server (git pull → build → compose up)
    ├── setup-env.sh           # Upload .env file to server
    ├── seed-admin.sh          # Create or promote admin user on the server
    └── logs.sh                # Stream container logs from the server
```

## Architecture

```
Internet (herobids.com)
  │
  └─ Caddy (TLS termination, port 80/443, Let's Encrypt auto-renewal)
       ├─ /health          → api:3000
       ├─ /api/*           → api:3000 (Hono REST API)
       └─ /*               → web:80 (nginx serving Vite SPA)

Services (docker compose):
  caddy       — Reverse proxy + TLS (caddy:2-alpine)
  api         — Hono HTTP API (port 3000)
  web         — Vite React SPA via nginx (port 80)
  worker      — Long-running process: trading actors, stream pool, scan loops
  postgres    — PostgreSQL 17 (internal, no host port)
  redis       — Redis 7 (internal, no host port)
  migrate     — Drizzle migrations (runs once, exits)
  docker-proxy — Docker socket proxy for worker's Docker-in-Docker

Host-level security:
  UFW firewall (configured by cloud-init) allows only ports 22, 80, 443.
  Docker-published ports for postgres, redis, api, and web are blocked at the host
  level — all access goes through Caddy.
```

## Prerequisites

- **Terraform >= 1.0** — `brew install terraform` (macOS) or [terraform.io/downloads](https://developer.hashicorp.com/terraform/install)
- **Hetzner Cloud API token** — generate at [Hetzner Cloud Console](https://console.hetzner.cloud/)
- **SSH key pair** — used for server access and git deploy key
- **Herobids repo URL** — private repo with deploy key access

## First-Time Setup

```bash
# 1. Copy and fill in terraform variables
# Edit terraform.tfvars — !!! See: infra/hetzner/docs/setup-tfvars.md !!!
cp terraform.tfvars.example terraform.tfvars

# 2. Provision the server (Terraform init + apply)
./scripts/provision.sh

# 3. Upload your .env file (production secrets)
./scripts/setup-env.sh --file .env.prod

# 4. Full deploy (env upload → push → seed admin → health verify)
./deploy.sh --env-file .env.prod

# 5. Seed admin user (one-time — the deploy script runs this automatically if
#    ADMIN_EMAIL and ADMIN_PASSWORD are set, otherwise run it manually)
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=strong-pass ./scripts/seed-admin.sh
```

### Required `.env` variables

The `.env.prod` file must include at minimum:

```bash
AUTH_JWT_SECRET=<32+ char random string>     # generate: openssl rand -hex 32
AUTH_PUBLIC_BASE_URL=https://herobids.com
AUTH_FRONTEND_ORIGIN=https://herobids.com

> **Note:** `AUTH_PUBLIC_BASE_URL` and `AUTH_FRONTEND_ORIGIN` are hardcoded in
> `docker-compose.prod.yaml` (which takes precedence over `.env`). For custom
> domains, edit the compose file directly — changing only `.env` has no effect.

OPENAI_API_KEY=sk-...                        # LLM provider
ANTHROPIC_API_KEY=sk-ant-...                 # LLM provider (optional)
HYPERLIQUID_ACCOUNT_ADDRESS=0x...            # Venue API keys
HYPERLIQUID_API_KEY=0x...
HYPERLIQUID_SECRET=0x...
```

Database and Redis URLs default to docker-compose values and do not need to be in `.env` unless using external services.

## Day-to-Day Operations

```bash
# Deploy latest code
./scripts/push.sh --yes

# Deploy latest code to a specific server IP
./scripts/push.sh --yes 1.2.3.4

# Stream all container logs
./scripts/logs.sh

# Stream logs for specific services
./scripts/logs.sh -- api worker

# Stream logs from a specific server
./scripts/logs.sh 1.2.3.4 -- api

# SSH into the server
ssh root@$(terraform output -raw server_ipv4)

# Re-run database migrations manually
ssh root@<IP> 'cd /opt/herobids && docker compose -f docker-compose.yaml -f docker-compose.prod.yaml run --rm migrate'

# Restart all services
ssh root@<IP> 'cd /opt/herobids && docker compose -f docker-compose.yaml -f docker-compose.prod.yaml up -d --build'
```

## Full Deploy Workflow

`deploy.sh` orchestrates a complete deployment in 4 steps:

1. **setup-env** — upload `.env` to the server
2. **push** — `git pull` → build agent image → `docker compose up -d --build` → health check
3. **seed-admin** — create/promote admin user (skipped if `ADMIN_EMAIL`/`ADMIN_PASSWORD` not set)
4. **verify** — curl the API health endpoint until it responds (up to 60s)

If any step fails, the script stops immediately — no partial deploys.

## Troubleshooting

| Issue | Diagnosis | Fix |
|-------|-----------|-----|
| **Server unreachable** | `ssh root@<IP>` fails | Check Hetzner console — is the server running? Verify UFW allows port 22. |
| **API health check fails** | `ssh root@<IP> 'curl -sf http://localhost:3000/health'` fails | Port 3000 is blocked by UFW externally — health check must be run via SSH. Check logs: `./scripts/logs.sh -- api migrate`. Ensure `.env` is uploaded. |
| **Caddy can't get TLS cert** | Browser shows certificate error | Verify DNS A/AAAA records point to server IP. Check `docker compose logs caddy`. |
| **Migrations didn't run** | API logs show missing tables | Run manually: `ssh root@<IP> 'cd /opt/herobids && docker compose -f docker-compose.yaml -f docker-compose.prod.yaml run --rm migrate'` |
| **Agent image not found** | Worker logs "image not found" | The agent image must be built before worker starts. Run `./scripts/push.sh` which builds it. |
| **terraform.tfvars not found** | `provision.sh` fails with error | `cp terraform.tfvars.example terraform.tfvars` and fill in required values. |
| **Git clone fails on server** | cloud-init log shows SSH error | Verify `deploy_ssh_private_key` is a valid key with read access to the repo. |
| **Let's Encrypt cert never issued** | Caddy stuck, no HTTPS | Ensure port 80 is reachable (Let's Encrypt HTTP challenge). Check UFW and Hetzner firewall. |

### Checking server logs directly

```bash
# cloud-init logs (first-boot provisioning)
ssh root@<IP> 'tail -f /var/log/cloud-init-output.log'

# Docker compose logs (all services)
ssh root@<IP> 'cd /opt/herobids && docker compose -f docker-compose.yaml -f docker-compose.prod.yaml logs -f'

# Backup cron logs
ssh root@<IP> 'tail -f /var/log/herobids-backup.log'
```
