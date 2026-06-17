# Deploy Herobids to Hetzner VPS (Greenfield)

**Status:** Draft  
**Created:** 2026-06-17  
**Goal:** Stand up a production deployment of herobids on the existing Hetzner CPX22 VPS (IP backing `herobids.com`). Greenfield — no data migration from aitradingbot.

---

## Architecture Overview

```
Internet (herobids.com)
  │
  └─ Caddy (TLS termination, port 80/443)
       ├─ /api/*     → api:3000 (internal)
       ├─ /health    → api:3000 (internal)
       └─ /*         → web:80 (nginx serves static assets)
```

- **Caddy** handles Let's Encrypt TLS auto-renewal and reverse-proxies to internal services.
- **Web** (Vite build → nginx on port 80) serves the React SPA.
- **API** (Hono on port 3000) handles REST + OAuth.
- **Worker** runs agent trading actors via Docker-in-Docker.
- **Postgres 17** and **Redis 7** are internal-only (no host ports exposed).

---

## Phase 1: Production Compose & Caddy (local, no server changes)

### 1. Create `Caddyfile` at repo root

```caddyfile
{
    email admin@herobids.com
}

herobids.com, www.herobids.com {
    @api path /api/* /health
    reverse_proxy @api api:3000
    reverse_proxy web:80
}
```

**Key points for the implementer:**
- Caddy listens on host ports 80/443, proxies internally to `api:3000` and `web:80`.
- The web service's nginx serves static assets on port 80 (see `apps/web/Dockerfile` — `EXPOSE 80`).
- No separate `/health` route needed; Caddy routes it to the same api upstream.

### 2. Create `docker-compose.prod.yaml` (production override)

| Change | Detail |
|--------|--------|
| Remove host ports from postgres (5432), redis (6379) — internal only |
| Add `caddy` service — `caddy:2-alpine`, ports 80/443, volumes for Caddyfile + data dirs |
| Add `caddy_data` and `caddy_config` named volumes for Let's Encrypt certs |
| Set production env vars via `env_file: .env` (no hardcoded secrets) |
| Add restart policies (`unless-stopped`) to all long-running services |
| Remove dev port bindings (5432, 6379, 5173) |
| Web depends_on api (healthy); caddy depends_on web (started) |

The base `docker-compose.yaml` already has:
- postgres:17-alpine with healthcheck
- redis:7-alpine with healthcheck
- api on port 3000 with healthcheck
- web on port 80 (nginx) — mapped to host 5173 in dev, removed in prod
- migrate service (runs once, then exits)
- docker-proxy for Docker-in-Docker

### 3. Create `.env.example` at repo root

Document all required production secrets:

```bash
# ── Database ──────────────────────────────────────────────
DATABASE_URL=postgres://herobids:<PASSWORD>@postgres:5432/herobids

# ── Redis ─────────────────────────────────────────────────
REDIS_URL=redis://redis:6379

# ── API / Auth ────────────────────────────────────────────
PORT=3000
AUTH_JWT_SECRET=<32+ char random string>
AUTH_PUBLIC_BASE_URL=https://herobids.com
AUTH_FRONTEND_ORIGIN=https://herobids.com

# ── LLM Providers ─────────────────────────────────────────
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...

# ── Venue API Keys ────────────────────────────────────────
HYPERLIQUID_ACCOUNT_ADDRESS=0x...
HYPERLIQUID_API_KEY=0x...
HYPERLIQUID_SECRET=0x...
BASE_WALLET_PRIVATE_KEY=0x...

# ── Other ─────────────────────────────────────────────────
HCLOUD_TOKEN=<ref only — do not store in .env>
```

**Implementer notes:**
- Compare against `scripts/.env.example` for venue/bridging vars.
- Only reference aitradingbot's `.env` to identify any env var names that overlap (not to copy values).

---

## Phase 2: Infrastructure Scripts (`infra/hetzner/`)

### 4. Create `infra/hetzner/main.tf`

Terraform resources for the Hetzner server:
- Provider: `hcloud ~> 1.49`
- Resources: SSH key, firewall (22/80/443 in, all out), server (CPX22, fsn1, ubuntu-24.04)
- `lifecycle { prevent_destroy = true }` — protects against accidental teardown
- Labels: `app = "herobids"`

### 5. Create `infra/hetzner/variables.tf`

| Variable | Default | Purpose |
|----------|---------|---------|
| `hcloud_token` | (required) | Hetzner API token |
| `server_name` | `herobids` | Server hostname |
| `server_type` | `cx22` | Instance type |
| `location` | `fsn1` | Datacenter |
| `image` | `ubuntu-24.04` | OS image |
| `ssh_public_key_path` | (required) | Path to SSH public key |
| `deploy_ssh_private_key` | (required) | Private SSH key content for deploy key access to git repo |
| `git_repo_url` | (required) | Herobids repo URL (private, with deploy key) |
| `git_branch` | `main` | Branch to deploy |
| `app_domain` | `herobids.com` | Domain name |

### 6. Create `infra/hetzner/outputs.tf`

- `server_ip`, `server_ipv6`
- `ssh_command` (formatted for copy-paste)
- `frontend_url` (`https://herobids.com`)
- `api_url` (`https://herobids.com/api`)

### 7. Create `infra/hetzner/cloud-init.yaml`

First-boot script on the server:
1. Install Docker CE, UFW (22/80/443), fail2ban
2. Clone herobids repo to `/opt/herobids`
3. Create `.env` from `.env.example` (placeholder)
4. Set up daily Postgres backup cron (14-day retention)
5. Create systemd service `herobids.service` for auto-start on reboot

### 8. Create `infra/hetzner/terraform.tfvars.example`

Template for Terraform variables.

---

## Phase 3: Deploy & Operations Scripts

### 9. Create `infra/hetzner/scripts/provision.sh`

Terraform init + apply. One command to stand up the server.

### 10. Create `infra/hetzner/scripts/push.sh` — deploy script

```bash
# SSH into server
ssh root@<IP> 'cd /opt/herobids && git fetch --all && git reset --hard origin/main'

# Build agent image (full repo context sent to Docker daemon)
docker build -f docker/Dockerfile.agent -t herobids-agent:latest .

# Start services
docker compose -f docker-compose.yaml -f docker-compose.prod.yaml up -d --build

# Migrations run automatically via depends_on; manual re-run:
docker compose -f docker-compose.yaml -f docker-compose.prod.yaml run --rm migrate
```

**Implementer notes:**
- The agent image build sends the full repo as Docker context over SSH. For a one-time deploy this is acceptable; if deploys become frequent, consider pushing to a registry instead.
- Migrations run automatically via the `migrate` service's `depends_on`. An explicit `docker compose run --rm migrate` is only needed for manual re-runs.

### 11. Create `infra/hetzner/scripts/setup-env.sh`

Upload `.env` to server — interactive prompts or `--file .env.prod`.

### 12. Create `infra/hetzner/scripts/seed-admin.sh`

Run the admin seeding script against the production database:

```bash
ssh root@<IP> 'cd /opt/herobids && \
  ADMIN_EMAIL=<email> ADMIN_PASSWORD=<password> DATABASE_URL=postgres://herobids:<pass>@localhost:5432/herobids \
  npx tsx scripts/ts/seed-admin.ts'
```

The script at `scripts/ts/seed-admin.ts`:
- Creates or promotes a user to admin (idempotent)
- Requires `ADMIN_EMAIL` and `ADMIN_PASSWORD` env vars
- Does NOT auto-generate passwords (intentional — avoids logging credentials)
- Is safe to re-run

### 13. Create `infra/hetzner/scripts/logs.sh`

Stream container logs: `docker compose -f docker-compose.yaml -f docker-compose.prod.yaml logs -f`

### 14. Create `infra/hetzner/deploy.sh`

Orchestrator: env upload → push → seed admin → verify.

### 15. Create `infra/hetzner/README.md`

Quick-start, directory structure, day-to-day ops commands.

---

## Phase 4: First Production Deploy (manual, one-time)

This is the **initial** deployment. Subsequent deploys use `deploy.sh`.

### Step 1: Provision the server

```bash
cd infra/hetzner && terraform init && terraform apply
```

### Step 2: Upload production `.env`

```bash
./scripts/setup-env.sh --file .env.prod
```

### Step 3: Deploy herobids

```bash
./scripts/deploy.sh
```

This runs: git fetch → build agent image → compose up → run migrations → seed admin → verify.

### Step 4: Verify

- `curl https://herobids.com/health` returns 200
- Web UI loads at `https://herobids.com`
- API responds at `https://herobids.com/api/`
- Admin user can log in with the seeded credentials

### Step 5: Enable systemd service (if cloud-init didn't)

```bash
systemctl enable herobids.service && systemctl start herobids.service
```

---

## Post-Implementation Report

After completing all phases, the operator should have this checklist of **remaining manual steps** (things that cannot be automated):

### Environment Variables to Add

| Variable | Where | Notes |
|----------|-------|-------|
| `AUTH_JWT_SECRET` | Server `/opt/herobids/.env` | Generate: `openssl rand -hex 32` |
| `AUTH_PUBLIC_BASE_URL` | Server `/opt/herobids/.env` | Set to `https://herobids.com` |
| `AUTH_FRONTEND_ORIGIN` | Server `/opt/herobids/.env` | Set to `https://herobids.com` |
| LLM API keys | Server `/opt/herobids/.env` | OpenAI, Anthropic, etc. as needed |
| Venue API keys | Server `/opt/herobids/.env` | Hyperliquid, Jupiter, 1inch as needed |

### Scripts to Run (in order)

```bash
# 1. Provision server (one-time)
cd infra/hetzner && terraform apply

# 2. Upload .env
./scripts/setup-env.sh --file .env.prod

# 3. Deploy everything
./scripts/deploy.sh

# 4. Seed admin user (one-time, after deploy)
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=<strong-password> ./scripts/seed-admin.sh
```

### Things That Cannot Be Automated

| Item | Why | Action |
|------|-----|--------|
| **Let's Encrypt email** | Requires human confirmation of ToS | Set in Caddyfile `email` directive, run once to get cert |
| **Admin password** | Security — never auto-generate or log credentials | Manually set `ADMIN_PASSWORD` when running seed-admin |
| **Venue API keys** | Sensitive secrets from external providers | Paste into `.env.prod` before deploy |
| **LLM API keys** | Sensitive secrets from external providers | Paste into `.env.prod` before deploy |
| **DNS propagation check** | Verify Caddy's Let's Encrypt cert issued | Check `https://herobids.com` in browser after deploy |

---

## Outstanding Issues

### [Item 3: .env.example]
- **[LOW] L1:** Awkward phrasing on AUTH_JWT_SECRET/AUTH_SECRET clarification comment — could be reworded for clarity.
- **[LOW] L2:** Venue API Keys section sits between RPC endpoints and Billing — consider grouping venue config together.

### [Item 2: docker-compose.prod.yaml]
- **[LOW] L1:** Header comment should mention `worker` + `docker-proxy` are inherited unchanged.
- **[LOW] L2:** Hardcoded auth URLs (`https://herobids.com`) — consider `${VAR:-default}` substitution for staging reuse.
- **[LOW] L3:** No healthcheck on `caddy` service — add `caddy version` healthcheck.
- **[LOW] L4:** Header comment should clarify that production secrets come from `.env` on the server.
- **[LOW] L5:** `env_file` merge behavior (required: false from base) — operator awareness note, no action needed.

### [Item 1: Caddyfile]
- **[MEDIUM] M1:** No explicit log configuration — add `log { output stdout; format json; }` directive for structured production logging.
- **[LOW] L1:** No canonical domain redirect — `www.herobids.com` should redirect to `herobids.com` (or vice versa) for SEO consistency.
- **[LOW] L2:** Missing additional defense-in-depth headers (`Referrer-Policy`, `Permissions-Policy`, `Content-Security-Policy`).
- **[LOW] L3:** Bare `/api` path (no trailing path) falls through to SPA handler — consider adding `handle /api { redir / }` or returning 404.

## Decisions & Notes

| Decision | Rationale |
|----------|-----------|
| Fresh deployment, no data migration | Herobids is a different app; aitradingbot state is irrelevant |
| Caddy for TLS | Auto Let's Encrypt, zero-config HTTPS |
| Separate `docker-compose.prod.yaml` | Keep dev compose clean; prod overlay adds Caddy + removes exposed ports |
| `/opt/herobids` on server | Clean directory for herobids deployment |
| Terraform with `prevent_destroy` | Protects the server from accidental teardown |
| Agent image built on server | Acceptable for manual deploys; revisit if CI/CD is added later |

---

## Checklist

- [ ] Phase 1: Caddyfile + docker-compose.prod.yaml + .env.example
- [ ] Phase 2: Terraform + cloud-init + variables + outputs
- [ ] Phase 3: Deploy scripts (provision, push, setup-env, seed-admin, logs, deploy orchestrator, README)
- [ ] Phase 4: First production deploy (provision → env → deploy → seed admin → verify)
