# Migrate herobids.com Domain to This Repository

**Status:** Draft  
**Created:** 2026-06-14  
**Goal:** Make https://herobids.com serve this repository (herobids) instead of aitradingbot, using the existing Hetzner VPS.

---

## Context

- **aitradingbot** is currently deployed on a Hetzner CPX22 VPS (2 vCPU, 4 GB RAM, Falkenstein) at the server IP backing `herobids.com`.
- That deployment uses: Terraform for provisioning, cloud-init for first-boot, Caddy for HTTPS/reverse-proxy, and shell scripts (`deploy.sh`, `push.sh`, `setup-env.sh`) for day-to-day operations.
- **herobids** (this repo) has Docker Compose services (postgres, redis, api, worker, web, docker-proxy, agent) but no production infra, no TLS termination, and no deploy scripts.
- The existing Hetzner server and IP address will be reused — no DNS change required.

---

## Plan

### Phase 1: Production Compose & Caddy (local, no server changes)

1. **Create `Caddyfile`** at repo root
   - TLS with auto Let's Encrypt (`email admin@herobids.com`)
   - Route `herobids.com` and `www.herobids.com`:
     - `/api/*` → reverse proxy to `api:3000`
     - `/health` → reverse proxy to `api:3000`
     - Everything else → reverse proxy to `web:80`

2. **Create `docker-compose.prod.yaml`** (production override)
   - Removes exposed host ports from postgres/redis (internal only)
   - Adds `caddy` service (`caddy:2-alpine`) with ports 80/443, volumes for Caddyfile, caddy_data, caddy_config
   - Sets production env vars via `env_file: .env` (no hardcoded passwords)
   - Adds `caddy_data` and `caddy_config` named volumes
   - Adds restart policies to all services
   - Removes dev-only port bindings (5432, 6379, 5173)
   - Web service depends on api; caddy depends on web

3. **Create `.env.example`** documenting all required production secrets:
   - `DATABASE_URL`, `REDIS_URL`, `HCLOUD_TOKEN` (reference only)
   - `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, venue API keys
   - `AUTH_SECRET`, `AUTH_PUBLIC_BASE_URL`, `AUTH_FRONTEND_ORIGIN`
   - Any other secrets from current aitradingbot `.env`

### Phase 2: Infrastructure Scripts (`infra/hetzner/`)

4. **Create `infra/hetzner/main.tf`** — adapted from aitradingbot:
   - Provider: `hcloud ~> 1.49`
   - Resources: SSH key, firewall (22/80/443 in, all out), server (CPX22, fsn1, ubuntu-24.04)
   - `lifecycle { prevent_destroy = true }` (reuse existing server)
   - Labels: `app = "herobids"`

5. **Create `infra/hetzner/variables.tf`**:
   - `hcloud_token`, `server_name` (default: `herobids`), `server_type`, `location`, `image`
   - `ssh_public_key_path`, `ssh_private_key_path`, `git_repo_url`, `git_branch`
   - `app_domain` (default: `herobids.com`), `enable_backups`, `firewall_ssh_allow`

6. **Create `infra/hetzner/outputs.tf`**:
   - `server_ip`, `server_ipv6`, `ssh_command`
   - `frontend_url` (https://herobids.com), `api_url` (https://herobids.com/api)

7. **Create `infra/hetzner/cloud-init.yaml`**:
   - Install Docker CE, UFW (22/80/443), fail2ban
   - Clone this repo to `/opt/herobids`
   - Create placeholder `.env` from `.env.example`
   - Daily Postgres backup cron (14-day retention)
   - Systemd service `herobids.service` for auto-start

8. **Create `infra/hetzner/terraform.tfvars.example`**

### Phase 3: Deploy & Operations Scripts

9. **Create `infra/hetzner/scripts/provision.sh`** — terraform init + apply

10. **Create `infra/hetzner/scripts/push.sh`**:
    - SSH into server, `git fetch && git reset --hard origin/main`
    - Build agent image (`docker build -f docker/Dockerfile.agent -t herobids-agent:latest .`)
    - `docker compose -f docker-compose.yaml -f docker-compose.prod.yaml up -d --build`
    - Run migrations via the migrate service
    - Optional `--roll-actors` for rolling restart of agent containers
    - Record deployed SHA

11. **Create `infra/hetzner/scripts/setup-env.sh`** — upload .env to server (interactive or `--file`)

12. **Create `infra/hetzner/scripts/logs.sh`** — stream container logs

13. **Create `infra/hetzner/deploy.sh`** — orchestrator (env upload + push)

14. **Create `infra/hetzner/README.md`** — quick-start, directory structure, day-to-day ops

### Phase 4: Server Migration (manual, one-time)

15. **Stop aitradingbot on the server:**
    ```bash
    ssh root@<IP>
    cd /opt/aitradingbot && docker compose down
    systemctl disable aitradingbot.service
    ```

16. **Back up aitradingbot database** (in case rollback is needed):
    ```bash
    docker compose exec -T postgres pg_dump -U aitradingbot aitradingbot | gzip > /opt/backups/aitradingbot-final.sql.gz
    ```

17. **Clone herobids and deploy:**
    ```bash
    git clone <herobids-repo-url> /opt/herobids
    cp /opt/herobids/.env.example /opt/herobids/.env
    # Fill in secrets
    cd /opt/herobids
    docker compose -f docker-compose.yaml -f docker-compose.prod.yaml up -d --build
    ```

18. **Verify:**
    - `curl https://herobids.com/health` returns 200
    - Web UI loads at `https://herobids.com`
    - API responds at `https://herobids.com/api/`

19. **Enable systemd service** for auto-start on reboot

20. **Clean up aitradingbot artifacts** (after stability period):
    - Remove `/opt/aitradingbot`
    - Prune old Docker images
    - Update backup cron to reference herobids

---

## Decisions & Notes

| Decision | Rationale |
|----------|-----------|
| Reuse existing VPS + IP | Zero DNS propagation, no downtime, saves cost |
| Caddy for TLS | Auto Let's Encrypt, zero-config HTTPS, already proven in aitradingbot |
| Separate `docker-compose.prod.yaml` | Keep dev compose clean; prod overlay adds Caddy + removes exposed ports |
| `/opt/herobids` on server | Clean separation from aitradingbot during transition |
| Keep Terraform with `prevent_destroy` | Protects the server from accidental teardown; Terraform manages firewall/SSH but doesn't recreate the VPS |

---

## Out of Scope

- CI/CD pipeline (GitHub Actions) — future enhancement
- Multi-server / load balancer setup
- Database migration from aitradingbot (different app, fresh DB)
- Monitoring/alerting stack (Grafana, Prometheus)

---

## Rollback Plan

If herobids deployment fails:
1. `cd /opt/herobids && docker compose down`
2. `cd /opt/aitradingbot && docker compose up -d`
3. `systemctl enable aitradingbot.service`

Domain continues serving aitradingbot with zero DNS changes.

---

## Checklist

- [ ] Phase 1: Caddyfile + docker-compose.prod.yaml + .env.example
- [ ] Phase 2: Terraform + cloud-init + variables
- [ ] Phase 3: Deploy scripts (provision, push, setup-env, logs, deploy orchestrator, README)
- [ ] Phase 4: Server migration (stop old, backup, clone new, verify, enable systemd)
- [ ] Phase 5: Cleanup (remove aitradingbot from server after stability period)
