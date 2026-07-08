# Hetzner Deployment — Herobids

Deployment of Herobids on Hetzner Cloud VPS (CPX22, Ubuntu 24.04). Supports two environments: **staging** and **production**.

## Environments

| | Staging | Production |
|---|---|---|
| **Purpose** | Pre-production validation, smoke tests, deploy rehearsals | Live trading, real users |
| **Terraform `environment` var** | `staging` | `production` |
| **Server name** | `herobids-staging` | `herobids` |
| **App domain** | `staging.herobids.com` | `herobids.com` |
| **Env file** | `.env.staging` | `.env.prod` |
| **Compose overlay** | `docker-compose.staging.yaml` | `docker-compose.prod.yaml` |
| **NODE_ENV** | `staging` | `production` |
| **Terraform state** | Separate `terraform.tfvars` per environment (future: workspaces) | |

### Naming conventions

- **Server name**: `herobids` for production, `herobids-staging` for staging. Override via `server_name` in `terraform.tfvars` if the convention doesn't fit.
- **App domain**: `herobids.com` for production, `staging.herobids.com` for staging. Override via `app_domain` in `terraform.tfvars`.
- **Env file**: `.env.staging` and `.env.prod` in the repo root (gitignored). The `--file` flag on `setup-env.sh` accepts any path.
- **Compose overlay**: `docker-compose.{staging,prod}.yaml`. Scripts auto-select the correct overlay from `HEROBIDS_ENV`.
- **Terraform state**: Use separate `terraform.tfvars` files per environment (e.g., `terraform.tfvars.staging`, `terraform.tfvars.prod`) and symlink or copy the active one to `terraform.tfvars` before running `provision.sh`.

### Selecting an environment

All deploy scripts accept `--env staging` or `--env production`. If omitted, `HEROBIDS_ENV` is read from the environment, defaulting to `production`.

```bash
# Set via flag
./scripts/push.sh --env staging --yes
./deploy.sh --env staging --env-file .env.staging

# Set via environment variable
HEROBIDS_ENV=staging ./scripts/logs.sh -- api worker
```

### Runtime Policy

Each environment enforces a specific runtime policy through config defaults and startup guards. The table below summarizes what each environment is permitted to do:

| Capability | Staging | Production |
|---|---|---|
| **Live trading** | Disabled by default (`liveRollout.enabled: false`). Override via `LIVE_ROLLOUT_ENABLED=true` for smoke tests only. | Requires explicit opt-in (`LIVE_ROLLOUT_ENABLED=true`). |
| **Billing** | Mock by default (`billing.primaryProvider: mock`). No real charges. | **Real billing required.** Startup guard refuses to boot if `primaryProvider` is `mock` when `NODE_ENV=production`. Set `BILLING_PRIMARY_PROVIDER=creem` (or `stripe`). |
| **Alerts** | Disabled by default (`alerts.enabled: false`). Enable explicitly for webhook/debugging smoke tests. | Requires explicit opt-in (`ALERTS_ENABLED=true`). |
| **Log level** | `debug` — verbose output for troubleshooting. | `info` (default) — normal operational logging. |
| **Secrets** | Separate `.env.staging` with test-only credentials, OAuth clients, Telegram tokens, and LLM keys. | Separate `.env.prod` with production secrets. Never share secrets between environments. |
| **Data isolation** | Independent server, volumes, DB, Redis. No shared state with production. | Independent server, volumes, DB, Redis. |
| **Server lifecycle** | No `prevent_destroy` — can be torn down and recreated freely. | `prevent_destroy = true` in Terraform — accidental destroy is blocked. |
| **Auth origins** | `staging.herobids.com` | `herobids.com` / `www.herobids.com` / `app.herobids.com` |
| **LLM provider** | Same provider as production (OpenRouter). Use separate API keys to isolate costs. | OpenRouter with production API key. |

#### Startup Guards

The following guards are enforced at process startup and are verified to work correctly with the environment split:

| Guard | File | Behavior |
|---|---|---|
| **Production billing** | `apps/api/src/config.ts`, `apps/worker/src/config.ts` | Refuses to start if `NODE_ENV=production` and `billing.primaryProvider === 'mock'`. Staging (`NODE_ENV=staging`) is not affected. |
| **Insecure JWT secret** | `apps/api/src/plugins/auth.ts` | Refuses to start if `AUTH_JWT_SECRET` is the default placeholder in any non-dev, non-test environment. Both staging and production are protected. |
| **Dev-only LLM models** | `apps/api/src/llm-model-catalog.ts` | Filters out models marked `devOnly: true` and disables dynamic catalog mode when `NODE_ENV=production`. Staging is not affected. |
| **Ollama discovery** | `apps/api/src/llm-model-catalog.ts` | Skips local Ollama model discovery in production. Staging and development can use it. |

All guards key off `NODE_ENV` which is set correctly per environment in the compose overlays:
- `docker-compose.staging.yaml` → `NODE_ENV: staging`
- `docker-compose.prod.yaml` → `NODE_ENV: production`

## Directory Structure

```
infra/hetzner/
├── main.tf                    # Terraform: server, firewall, SSH key
├── variables.tf               # Terraform: input variables (includes environment)
├── outputs.tf                 # Terraform: output values (IPs, URLs, SSH command)
├── cloud-init.yaml            # First-boot provisioning (Docker, UFW, git clone, backups)
├── terraform.tfvars.example   # Template for terraform variables
├── deploy.sh                  # Full deploy orchestrator (env → push → seed → verify)
├── README.md                  # This file
└── scripts/
    ├── _ssh_opts.sh           # Shared SSH options + environment helpers
    ├── provision.sh           # Terraform init + apply
    ├── push.sh                # Deploy latest code to server (git pull → build → compose up)
    ├── setup-env.sh           # Upload .env file to server
    ├── seed-admin.sh          # Create or promote admin user on the server
    ├── logs.sh                # Stream container logs from the server
    ├── reset.sh               # Wipe DB, Redis, Caddy; fresh start
    ├── reset-and-run.sh       # Nuclear reset + full provision
    ├── create-agents.sh       # Create agents on a HeroBids instance
    ├── maintenance-restart.sh         # Server-side agent container restart
    └── maintenance-restart-from-local.sh  # Run maintenance restart from local machine
```

## Architecture

```
Internet (herobids.com / staging.herobids.com)
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

## Isolation Model

Staging and production run on **separate Hetzner servers**. Each server has its own:

| Resource | Isolation |
|---|---|
| **Server** | Separate Hetzner Cloud instance (different IP, hostname) |
| **PostgreSQL** | Independent Docker named volume (`pgdata`) per server |
| **Redis** | Independent container per server (no shared state) |
| **Docker network** | Separate `herobids_default` bridge network per server |
| **Caddy data** | Independent `caddy_data` and `caddy_config` volumes (TLS certs per domain) |
| **Evaluation data** | Independent `evaldata` volume per server |
| **Secrets** | Separate `.env.staging` and `.env.prod` files |

Because Docker named volumes are local to each host, the separate-server model provides full
data isolation without any additional configuration. Staging mistakes cannot affect production
state.

Both environments share the same:
- Terraform configuration (`main.tf`, `variables.tf`, `cloud-init.yaml`)
- Docker base compose file (`docker-compose.yaml`)
- Codebase (deployed from the same git repo and branch)

Environment differentiation comes from `terraform.tfvars` values (server name, domain, compose
overlay selection) and environment-specific `.env` files.

### Server Lifecycle Protection

Production servers have `prevent_destroy = true` in Terraform to guard against accidental
`terraform destroy`. Staging servers do **not** have this protection — they can be torn down
and recreated freely for iteration.

To intentionally destroy a production server:
1. Temporarily set `environment = "staging"` in `terraform.tfvars`, run `terraform apply`,
   then `terraform destroy`.
2. Or: `terraform state rm 'hcloud_server.default'` then `terraform destroy`.

This protection is enforced in `main.tf` via:
```hcl
lifecycle {
  prevent_destroy = var.environment == "production"
}
```

## Prerequisites

- **Terraform >= 1.0** — `brew install terraform` (macOS) or [terraform.io/downloads](https://developer.hashicorp.com/terraform/install)
- **Hetzner Cloud API token** — generate at [Hetzner Cloud Console](https://console.hetzner.cloud/)
- **SSH key pair** — used for server access and git deploy key
- **Herobids repo URL** — private repo with deploy key access

## First-Time Setup

### Production

```bash
# 1. Copy and fill in terraform variables
# Set environment = "production" in terraform.tfvars (or leave default).
cp terraform.tfvars.example terraform.tfvars
# edit terraform.tfvars — fill in hcloud_token, ssh_public_key_path, deploy_ssh_private_key, git_repo_url

# 2. Provision the server (Terraform init + apply)
./scripts/provision.sh

# 3. Copy and fill in environment variables
cp ../../.env.example .env.prod
# edit .env.prod — fill in secrets (JWT, OAuth, billing, LLM keys, etc.)

# 4. Upload your .env file (production secrets)
./scripts/setup-env.sh --file .env.prod

# 5. Full deploy (env upload → push → seed admin → health verify)
./deploy.sh --env-file .env.prod

# 6. Seed admin user (one-time — the deploy script runs this automatically if
#    ADMIN_EMAIL and ADMIN_PASSWORD are set, otherwise run it manually)
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=strong-pass ./scripts/seed-admin.sh
```

### Staging

```bash
# 1. Copy and fill in terraform variables for staging
cp terraform.tfvars.example terraform.tfvars
# edit terraform.tfvars:
#   environment = "staging"
#   server_name = "herobids-staging"   # optional — follows convention
#   app_domain  = "staging.herobids.com"

# 2. Provision the staging server
./scripts/provision.sh --env staging

# 3. Create staging env file
cp ../../.env.example .env.staging
# edit .env.staging — use staging-safe secrets, test OAuth clients, mock billing

# 4. Upload staging env file
./scripts/setup-env.sh --env staging --file .env.staging

# 5. Deploy to staging
./deploy.sh --env staging --env-file .env.staging

# 6. Seed staging admin (if needed)
ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD=test-pass ./scripts/seed-admin.sh --env staging
```

### Managing Terraform State Per Environment

You need a separate `terraform.tfvars` for each environment because each points to a
different server, domain, and lifecycle policy. There is only one active `terraform.tfvars`
file at a time — Terraform reads `terraform.tfvars` from the current directory.

**Recommended workflow: keep source-of-truth files and symlink the active one.**

```bash
# Create the source-of-truth files (only needed once)
cp terraform.tfvars.example terraform.tfvars.prod
cp terraform.tfvars.example terraform.tfvars.staging

# Edit each with the correct environment values:
#   terraform.tfvars.prod  → environment = "production", server_name = "herobids", ...
#   terraform.tfvars.staging → environment = "staging", server_name = "herobids-staging", ...
```

**Provisioning production:**

```bash
cd infra/hetzner
ln -sf terraform.tfvars.prod terraform.tfvars
./scripts/provision.sh --env production
# Wait for cloud-init to finish (~3-5 minutes). Check progress:
#   ssh root@<IP> 'tail -f /var/log/cloud-init-output.log'
# Once complete, the server is ready for deploy.
```

**Provisioning staging:**

```bash
cd infra/hetzner
ln -sf terraform.tfvars.staging terraform.tfvars
./scripts/provision.sh --env staging
# Wait for cloud-init, then deploy.
```

**Alternative: use `-var-file` instead of symlinks.**

```bash
# This works but means you must pass -var-file to every terraform command.
terraform plan -var-file=terraform.tfvars.staging
terraform apply -var-file=terraform.tfvars.staging
```

The symlink approach is simpler because all scripts (`provision.sh`, deploy helpers,
ad-hoc terraform commands) automatically pick up the active `terraform.tfvars`.

> **Important:** Always check which environment is active before running terraform
> commands. `grep environment terraform.tfvars` tells you at a glance.

### Environment variable notes

- Database and Redis URLs default to docker-compose values and do not need to be in `.env` unless using external services.
- `AUTH_PUBLIC_BASE_URL`, `AUTH_FRONTEND_ORIGIN`, and `VITE_API_ORIGIN` are set per environment in the compose overlay (`docker-compose.prod.yaml` / `docker-compose.staging.yaml`). Each overlay uses the correct domain for its environment — no manual editing needed.
- Staging should use separate secrets from production: different JWT secret, OAuth client IDs, Telegram bot tokens, LLM API keys, and billing credentials.
- **Production billing guard**: The API and worker will refuse to start if `NODE_ENV=production` and `billing.primaryProvider` is still `'mock'`. Set `BILLING_PRIMARY_PROVIDER=creem` (or `stripe`) in `.env.prod`. See `apps/api/src/config.ts` and `apps/worker/src/config.ts` for the guard implementation.

## DNS & TLS

Both environments use Caddy for automatic TLS certificate provisioning via Let's Encrypt.
You must create DNS A records before the deploy will work over HTTPS.

### Required DNS Records

| Environment | Hostname | Type | Points To |
|---|---|---|---|
| **Production** | `herobids.com` | A | Production server IP |
| | `www.herobids.com` | A (or CNAME → `herobids.com`) | Production server IP |
| | `app.herobids.com` | A (or CNAME → `herobids.com`) | Production server IP |
| **Staging** | `staging.herobids.com` | A | Staging server IP |

> The production Caddyfile also handles `www.herobids.com` and `app.herobids.com` as
> alternative names on the same certificate. Staging uses a single domain.

### How TLS Works

1. Caddy starts and sees the configured domain(s) in its Caddyfile.
2. On first request, Caddy attempts a Let's Encrypt HTTP-01 challenge on port 80.
3. If port 80 is reachable from the internet, Let's Encrypt issues a certificate.
4. Caddy stores the certificate in the `caddy_data` Docker volume for renewal.
5. Renewals happen automatically ~30 days before expiry.

### Prerequisites for TLS

- **DNS must be configured before deploy.** The A record(s) must point to the server IP.
- **Port 80 must be reachable.** The Hetzner firewall (created by Terraform) and UFW
  (configured by cloud-init) both allow port 80 and 443 by default.
- **No other process on port 80/443.** Caddy binds these ports exclusively.

### Verifying TLS

```bash
# Check Caddy logs for certificate issuance
./scripts/logs.sh --env staging -- caddy | grep -i "certificate\|acme"

# Verify the certificate from your machine
curl -svI https://staging.herobids.com 2>&1 | grep -i "subject\|issuer\|expire"
```

If the certificate doesn't issue within a few minutes of the first HTTPS request:
- Verify DNS propagation: `dig staging.herobids.com` should return the server IP.
- Check the Hetzner firewall rules in the cloud console.
- See the troubleshooting table at the bottom of this document.

## Day-to-Day Operations

All commands accept `--env staging|production` (default: `production`).

```bash
# Deploy latest code to production
./scripts/push.sh --yes

# Deploy latest code to staging
./scripts/push.sh --env staging --yes

# Deploy to a specific server IP
./scripts/push.sh --env staging --yes 1.2.3.4

# Stream all container logs
./scripts/logs.sh
./scripts/logs.sh --env staging

# Stream logs for specific services
./scripts/logs.sh -- api worker
./scripts/logs.sh --env staging -- api worker

# Stream logs from a specific server
./scripts/logs.sh 1.2.3.4 -- api

# SSH into the server
ssh root@$(terraform output -raw server_ipv4)

# Re-run database migrations manually (replace <compose-overlay> with docker-compose.prod.yaml or docker-compose.staging.yaml)
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

The deploy target is determined by `--env` (or `HEROBIDS_ENV`), which selects the correct compose overlay for the environment. All sub-scripts (`push.sh`, `setup-env.sh`, `seed-admin.sh`) receive the same environment selection automatically.

```bash
# Production deploy
./deploy.sh --env-file .env.prod

# Staging deploy
./deploy.sh --env staging --env-file .env.staging
```

## Secret Rotation

To rotate secrets (JWT, API keys, OAuth credentials, etc.) for an environment:

### 1. Update the local env file

Edit `.env.staging` or `.env.prod` with the new secret values.

### 2. Upload the updated env file

```bash
# Staging
./scripts/setup-env.sh --env staging --file .env.staging

# Production
./scripts/setup-env.sh --env production --file .env.prod
```

This copies the file to `/opt/herobids/.env` on the target server with `chmod 600`.

### 3. Restart affected services

Most env var changes require a service restart to take effect. The simplest way is a
full redeploy:

```bash
# Staging
./scripts/push.sh --env staging --yes

# Production
./scripts/push.sh --env production --yes
```

To restart only specific services without a full git pull + rebuild:

```bash
ssh root@<IP> 'cd /opt/herobids && docker compose -f docker-compose.yaml -f docker-compose.staging.yaml up -d api worker'
```

### Secrets That Require Special Handling

| Secret | Rotate In | Also Update |
|---|---|---|
| JWT secret (`AUTH_JWT_SECRET`) | `.env.*` | All existing sessions are invalidated — users must re-login. |
| OAuth client secret | `.env.*` + OAuth provider console | Google Cloud Console / GitHub OAuth Apps / etc. |
| Telegram bot token | `.env.*` + BotFather | Rotating the token invalidates the old webhook. Re-register after restart. |
| LLM API key | `.env.*` | New key takes effect on next worker/agent restart. No other action needed. |
| Billing provider key | `.env.*` | Verify webhook endpoints still work after rotation. |
| `CREDENTIAL_ENCRYPTION_KEY` | `.env.*` | **Do NOT rotate unless you have a migration plan.** All stored venue credentials are encrypted with this key. Rotating it without re-encrypting existing data will make all stored credentials unreadable. |

### Verifying Secrets Took Effect

```bash
# Check that the worker picks up new env vars
./scripts/logs.sh --env staging -- worker | head -30

# Verify the API serves without startup guard failures
curl -sf https://staging.herobids.com/health
```

## Smoke-Test Checklist

After every staging deploy, run the smoke-test checklist to verify the environment is
healthy before using it for pre-production validation.

See the full runbook: **[Staging Smoke-Test Checklist](../../docs/runbooks/staging-smoke-test.md)**

Quick reference:

| # | Check | Expected |
|---|-------|----------|
| 1 | `curl -sf https://staging.herobids.com/health` | HTTP 200 |
| 2 | Open `https://staging.herobids.com` in browser | Page loads, no cert errors |
| 3 | OAuth login flow | Redirects use staging domain |
| 4 | Billing page | Renders without errors |
| 5 | `./scripts/logs.sh --env staging -- worker` | No startup guard failures |
| 6 | Telegram webhook (if configured) | Bot responds to messages |
| 7 | DB migrations | `docker compose ... run --rm migrate` succeeds |

## Troubleshooting

| Issue | Diagnosis | Fix |
|-------|-----------|-----|
| **Wrong environment targeted** | Check `HEROBIDS_ENV` is set correctly | Use `--env staging` or `--env production` explicitly. Verify with `echo $HEROBIDS_ENV`. |
| **Server unreachable** | `ssh root@<IP>` fails | Check Hetzner console — is the server running? Verify UFW allows port 22. |
| **API health check fails** | `ssh root@<IP> 'curl -sf http://localhost:3000/health'` fails | Port 3000 is blocked by UFW externally — health check must be run via SSH. Check logs: `./scripts/logs.sh -- api migrate`. Ensure `.env` is uploaded. |
| **Caddy can't get TLS cert** | Browser shows certificate error | Verify DNS A/AAAA records point to server IP. Check `docker compose logs caddy`. |
| **Migrations didn't run** | API logs show missing tables | Run manually: `ssh root@<IP> 'cd /opt/herobids && docker compose -f docker-compose.yaml -f docker-compose.{prod,staging}.yaml run --rm migrate'` |
| **Agent image not found** | Worker logs "image not found" | The agent image must be built before worker starts. Run `./scripts/push.sh` which builds it. |
| **terraform.tfvars not found** | `provision.sh` fails with error | `cp terraform.tfvars.example terraform.tfvars` and fill in required values, including `environment`. |
| **Git clone fails on server** | cloud-init log shows SSH error | Verify `deploy_ssh_private_key` is a valid key with read access to the repo. |
| **Let's Encrypt cert never issued** | Caddy stuck, no HTTPS | Ensure port 80 is reachable (Let's Encrypt HTTP challenge). Check UFW and Hetzner firewall. |

### Checking server logs directly

```bash
# cloud-init logs (first-boot provisioning)
ssh root@<IP> 'tail -f /var/log/cloud-init-output.log'

# Docker compose logs (all services — replace overlay file for your environment)
ssh root@<IP> 'cd /opt/herobids && docker compose -f docker-compose.yaml -f docker-compose.prod.yaml logs -f'

# Or use the logs helper (preferred):
./scripts/logs.sh --env staging

# Backup cron logs
ssh root@<IP> 'tail -f /var/log/herobids-backup.log'
```
