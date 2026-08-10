# Hetzner Deployment — Herobids

Deployment of Herobids on Hetzner Cloud VPS (CPX22, Ubuntu 24.04). Supports two environments: **staging** and **production**.

## Environments

| | Staging | Production |
|---|---|---|
| **Purpose** | Pre-production validation, smoke tests, deploy rehearsals | Live trading, real users |
| **Terraform `environment` var** | `staging` | `production` |
| **Server name** | `herobids-staging` | `herobids` |
| **App domain** | `staging.openaidom.com` | `openaidom.com` |
| **Env file** | `.env.staging` | `.env.prod` |
| **Compose overlay** | `docker-compose.staging.yaml` | `docker-compose.prod.yaml` |
| **NODE_ENV** | `staging` | `production` |
| **Terraform state** | Terraform workspaces (`staging` / `production`) | Terraform workspaces (`staging` / `production`) |

### Naming conventions

- **Server name**: `herobids` for production, `herobids-staging` for staging. Override via `server_name` in `terraform.tfvars` if the convention doesn't fit.
- **App domain**: `openaidom.com` for production, `staging.openaidom.com` for staging. Override via `app_domain` in `terraform.tfvars`.
- **Env file**: `.env.staging` and `.env.prod` in `infra/hetzner/` (gitignored). The `--file` flag on `setup-env.sh` accepts any path.
- **Compose overlay**: `docker-compose.{staging,prod}.yaml`. Scripts auto-select the correct overlay from `HEROBIDS_ENV`.
- **Terraform state**: Managed via workspaces. `provision.sh --env <name>` automatically selects the correct workspace. For manual terraform commands, switch first: `terraform workspace select staging` or `terraform workspace select production`.

### Selecting an environment

All deploy scripts accept `--env staging` or `--env production`. If omitted, `HEROBIDS_ENV` is read from the environment, defaulting to `production`.

```bash
# Set via flag
./scripts/push.sh --env staging --yes
./deploy.sh --env staging --env-file .env.staging

# Set via environment variable
HEROBIDS_ENV=staging ./scripts/logs.sh -- api worker
```

### Terraform Workspaces

Each environment has its own Terraform workspace:

| Workspace | Environment |
|---|---|
| `staging` | Staging server (`herobids-staging`) |
| `production` | Production server (`herobids`) |
| `default` | Deprecated — do not use |

All deploy scripts automatically select the correct workspace via the `--env` flag.

**Manual terraform commands** require explicit workspace selection:
```bash
cd infra/hetzner
terraform workspace select staging    # or: production
terraform plan                        # scoped to the selected environment
terraform state list                  # shows only that environment's resources
```

**Common workspace commands:**
```bash
terraform workspace list              # show all workspaces and which is active
terraform workspace show              # print the current workspace name
terraform workspace select staging    # switch to staging
```

**Provisioning a new environment:**
```bash
# Staging (already exists)
./scripts/provision.sh --env staging

# Production (created on first run)
./scripts/provision.sh --env production --var-file production.tfvars
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
| **Auth origins** | `staging.openaidom.com` | `openaidom.com` / `www.openaidom.com` / `app.openaidom.com` |
| **LLM provider** | Same provider as production (OpenRouter). Use separate API keys to isolate costs. | OpenRouter with production API key. |

#### Startup Guards

The following guards are enforced at process startup and are verified to work correctly with the environment split:

| Guard | File | Behavior |
|---|---|---|
| **Production billing** | `apps/api/src/config.ts`, `apps/worker/src/config.ts` | Refuses to start if `NODE_ENV=production` and `billing.primaryProvider === 'mock'`. Staging (`NODE_ENV=staging`) is not affected. |
| **Insecure JWT secret** | `apps/api/src/plugins/auth.ts` | Refuses to start if `AUTH_JWT_SECRET` is the default placeholder in any non-dev, non-test environment. Both staging and production are protected. |
| **Dev-only LLM models** | `apps/api/src/llm-model-catalog.ts` | Filters out models marked `devOnly: true` unless `NODE_ENV=development`, and disables dynamic catalog mode when `NODE_ENV=production`. Staging is blocked too. |
| **Ollama discovery** | `apps/api/src/llm-model-catalog.ts` | Skips local Ollama model discovery outside development. |

All guards key off `NODE_ENV` which is set correctly per environment in the compose overlays:
- `docker-compose.staging.yaml` → `NODE_ENV: staging`
- `docker-compose.prod.yaml` → `NODE_ENV: production`

## Directory Structure

```
infra/hetzner/
├── main.tf                         # Terraform: server, firewall, SSH key, network, agent pool
├── variables.tf                    # Terraform: input variables (includes environment, Nomad, agent pool)
├── outputs.tf                      # Terraform: output values (IPs, URLs, SSH command, Nomad cluster)
├── cloud-init.yaml                 # Control-plane first-boot provisioning (Docker, Nomad server, UFW, git clone)
├── cloud-init-nomad-client.yaml    # Agent node first-boot provisioning (Docker, Nomad client, UFW)
├── terraform.tfvars.example        # Template for terraform variables (single-file setup)
├── staging.tfvars.example          # Staging-specific tfvars template
├── remote.tfvars.example       # Production-specific tfvars template
├── deploy.sh                       # Full deploy orchestrator (env → push → seed → verify)
├── README.md                       # This file
└── scripts/
    ├── _ssh_opts.sh                # Shared SSH options + environment helpers
    ├── provision.sh                # Terraform init + plan + apply (supports --var-file)
    ├── push.sh                     # Deploy latest code to server (git pull → build → compose up)
    ├── setup-env.sh                # Upload .env file to server
    ├── seed-admin.sh               # Create or promote admin user on the server
    ├── logs.sh                     # Stream container logs from the server
    ├── reset.sh                    # Wipe DB, Redis, Caddy; fresh start
    ├── reset-and-run.sh            # Nuclear reset + full provision
    ├── create-agents.sh            # Create agents on a OpenAIdom instance
    ├── maintenance-restart.sh              # Server-side agent container restart
    ├── maintenance-restart-from-local.sh   # Run maintenance restart from local machine
    ├── scale-common.sh             # Autoscale shared functions (Nomad API, cooldown, flock, logging)
    ├── check-nomad-capacity.sh     # Poll Nomad cluster and compute free headroom
    ├── scale-out.sh                # Main autoscale loop: evaluate + provision agent nodes
    ├── scale-in.sh                 # Nightly conservative scale-in: drain idle nodes (Phase 7)
    └── check-placement-failures.sh # Safety net: detect resource-exhaustion placement failures (Phase 7)
    ├── alert-common.sh             # Alert threshold tracking + email sending (Phase 8)
    └── send-alert.sh               # Standalone alert test/manual trigger (Phase 8)
```

## Architecture

```
Internet (openaidom.com / staging.openaidom.com)
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

## Nomad Cluster Topology

When `enable_nomad = true` (default), each environment provisions its own Nomad cluster
for agent orchestration. The control plane remains on Docker Compose; agent containers
are scheduled by Nomad across disposable agent nodes.

### Cluster Layout

```
┌── Control Plane (Docker Compose) ──────────────────────┐
│  Caddy  │  API  │  Web  │  Worker  │  Postgres  │  Redis  │
│                          │                              │
│                   Nomad Server                          │
│                   (port 4646/4647/4648)                  │
└──────────────────────┬──────────────────────────────────┘
                       │ Private Network (10.x.0.0/16)
       ┌───────────────┼───────────────┐
       │               │               │
┌──────┴──────┐ ┌──────┴──────┐ ┌──────┴──────┐
│ Agent Node 1│ │ Agent Node 2│ │ Agent Node N│
│ Nomad Client│ │ Nomad Client│ │ Nomad Client│
│ Docker      │ │ Docker      │ │ Docker      │
└─────────────┘ └─────────────┘ └─────────────┘
```

### Nomad Topology (Phase 2)

- **Nomad server**: runs on the control-plane host (single server, no HA quorum).
  Installed natively via cloud-init. Configured as server-only (`client { enabled = false }`).
- **Nomad clients**: run on every agent node. Installed via `cloud-init-nomad-client.yaml`.
  Agents join the cluster using the server's private IP over the private network.
- **No HA quorum**: the single-server topology is sufficient for the initial scale target
  (200-2000 agents). HA Nomad (3-5 servers) can be added later if needed.

### Private Network

Each environment gets its own Hetzner Cloud Network (`hcloud_network`) with a `/16` CIDR
and a `/24` subnet. All control-plane and agent-node communication uses this private network.

| Environment | Network CIDR | Subnet CIDR |
|---|---|---|
| **Staging** | `10.0.0.0/16` | `10.0.0.0/24` |
| **Production** | `10.1.0.0/16` | `10.1.0.0/24` |

> ⚠️ If staging and production share a Hetzner project, their network CIDRs MUST NOT overlap.

### Agent Nodes

Agent nodes are disposable Nomad clients — cattle, not pets. They run only Docker + Nomad
and have no persistent state. Key characteristics:

- **Server type**: `cpx21` by default (2 vCPU, 4 GB RAM, 80 GB disk). Configurable via `agent_node_server_type`.
- **Firewall**: only SSH (port 22) from the internet. All Nomad traffic is internal on the private network.
- **Labels**: each node registers `environment`, `node_pool`, and `node_index` metadata for Nomad scheduling constraints.
- **Lifecycle**: agent nodes can be destroyed and recreated safely. The autoscaler (Phase 6) will manage node count.

### Port Reference

| Port | Service | Interface | Purpose |
|---|---|---|---|
| 4646 | Nomad HTTP API | Private network | CLI, UI, and worker adapter access to Nomad server |
| 4647 | Nomad RPC | Private network | Server ↔ client communication |
| 4648 | Nomad Serf | Private network | Gossip protocol for cluster membership |
| 22 | SSH | Public internet | Management access to all nodes |

### Feature Flag

Nomad infrastructure is toggleable via the `enable_nomad` Terraform variable. When `false`:
- No private network is created.
- No Nomad server is installed on the control plane.
- No agent nodes are provisioned.
- The existing single-server Docker Compose deployment is unchanged.

Set `enable_nomad = false` in your `terraform.tfvars` to disable all Nomad resources.

### Provisioning with Nomad

```bash
# Staging with Nomad + 1 agent node
cd infra/hetzner
cp staging.tfvars.example staging.tfvars
# Edit staging.tfvars: set agent_node_count = 1, fill in secrets
./scripts/provision.sh --env staging --var-file staging.tfvars

# Production with Nomad + 2 agent nodes (separate network range)
cp production.tfvars.example production.tfvars
# Edit production.tfvars: set agent_node_count = 2, fill in secrets
./scripts/provision.sh --env production --var-file production.tfvars
```

### Verifying the Cluster

After provisioning, verify the Nomad cluster is healthy:

```bash
# SSH to the control-plane server
ssh root@<control-plane-ip>

# Check Nomad server status
nomad server members

# Check Nomad client nodes (should list all agent nodes)
nomad node status

# Check cluster health from agent nodes
ssh root@<agent-node-ip>
nomad node status -self
```

### Agent Node Cloud-Init

Agent nodes use a dedicated cloud-init template (`cloud-init-nomad-client.yaml`) that:
1. Installs Docker CE and Nomad.
2. Configures Nomad as a client with Docker plugin.
3. Joins the cluster via `retry_join` to the Nomad server's private IP.
4. Sets up UFW to allow only SSH from the internet — all other traffic is private-network only.
5. Registers `environment`, `node_pool`, and `node_index` metadata for scheduling.

## Autoscale-Out (Phase 6)

The autoscale-out system automatically provisions additional agent nodes when Nomad cluster
capacity drops below configured thresholds. It uses a simple, low-cost design: a systemd timer
polls the Nomad API every 60 seconds, and when free capacity is low, provisions new agent nodes
via Terraform with `flock` serialization.

### How It Works

```
┌──────────────────────────────────────────────────────┐
│  systemd timer (every 60s)                           │
│    │                                                  │
│    ▼                                                  │
│  scale-out.sh                                        │
│    │                                                  │
│    ├─ 1. Read current agent_node_count from TF state │
│    ├─ 2. Check if at max_agent_nodes → skip          │
│    ├─ 3. Call check-nomad-capacity.sh                │
│    │     ├─ Poll Nomad /v1/nodes + /v1/node/{id}     │
│    │     ├─ Sum free memory across ready nodes       │
│    │     └─ Compute free agent slots                 │
│    ├─ 4. Compare vs thresholds (memory % + slots)    │
│    ├─ 5. Check cooldown → skip if too soon           │
│    ├─ 6. Acquire flock on lockfile                   │
│    └─ 7. terraform apply -auto-approve               │
│          -var agent_node_count=N+1                   │
└──────────────────────────────────────────────────────┘
```

### Scripts

| Script | Purpose |
|---|---|
| `scripts/scale-common.sh` | Shared functions: Nomad API helpers, logging, cooldown management, flock wrappers |
| `scripts/check-nomad-capacity.sh` | Poll Nomad API, compute free memory and agent slots, output key=value or JSON |
| `scripts/scale-out.sh` | Main autoscale loop: evaluate thresholds, acquire lock, run Terraform |

### Configuration

Autoscale behavior is controlled by Terraform variables (tracked in tfvars) and exposed to
the autoscale scripts via systemd environment directives in `cloud-init.yaml`.

| Variable | Default | Description |
|---|---|---|
| `scale_out_cooldown_seconds` | 300 (prod) / 120 (staging) | Minimum seconds between scale-out events |
| `scale_out_memory_threshold_pct` | 20 (prod) / 30 (staging) | Scale when free memory drops below this % |
| `scale_out_slot_threshold` | 3 (prod) / 2 (staging) | Scale when free agent slots drop below this count |
| `scale_out_increment` | 1 | Nodes to add per scale-out event |
| `agent_memory_reservation_mb` | 256 | MB per agent slot (used to compute slot count) |

All thresholds are also overridable via environment variables at runtime:

```bash
# Manual scale-out with custom thresholds
NOMAD_SCALE_OUT_MEMORY_THRESHOLD_PCT=10 \
NOMAD_SCALE_OUT_SLOT_THRESHOLD=1 \
  /opt/herobids/infra/hetzner/scripts/scale-out.sh

# Dry-run to check what would happen
/opt/herobids/infra/hetzner/scripts/scale-out.sh --dry-run

# Force scale-out (bypass thresholds, respect cooldown/max)
/opt/herobids/infra/hetzner/scripts/scale-out.sh --force

# Emergency scale-out (bypass cooldown too — safety-net path)
/opt/herobids/infra/hetzner/scripts/scale-out.sh --force --bypass-cooldown

# Safety-net convenience alias (equivalent to --force --bypass-cooldown)
/opt/herobids/infra/hetzner/scripts/scale-out.sh --safety-net
```

### Checking Capacity Manually

```bash
# Human-readable output (logs to stderr, data to stdout)
/opt/herobids/infra/hetzner/scripts/check-nomad-capacity.sh

# JSON output for scripting
/opt/herobids/infra/hetzner/scripts/check-nomad-capacity.sh --json | jq .

# Dry-run
/opt/herobids/infra/hetzner/scripts/check-nomad-capacity.sh --dry-run
```

### Systemd Units

The following systemd units are installed by cloud-init on the control-plane host:

| Unit | Type | Purpose |
|---|---|---|
| `nomad-autoscale.timer` | Timer (60s) | Triggers scale-out capacity check |
| `nomad-autoscale.service` | Oneshot | Runs `scale-out.sh` |
| `nomad-scale-in.timer` | Timer (daily, 3 AM) | Triggers nightly scale-in |
| `nomad-scale-in.service` | Oneshot | Runs `scale-in.sh` |
| `nomad-placement-failure-watcher.timer` | Timer (120s) | Triggers placement-failure safety net |
| `nomad-placement-failure-watcher.service` | Oneshot | Runs `check-placement-failures.sh` |

```bash
# Check all autoscale timer status
systemctl list-timers nomad-autoscale.timer nomad-scale-in.timer nomad-placement-failure-watcher.timer

# Check service run history
systemctl status nomad-autoscale.service
systemctl status nomad-scale-in.service
systemctl status nomad-placement-failure-watcher.service

# View unified autoscale log
journalctl -u nomad-autoscale -u nomad-scale-in -u nomad-placement-failure-watcher -n 50
tail -f /var/log/nomad-autoscale.log
```

### Cron Fallback

For environments without systemd, a cron entry achieves the same effect:

```bash
# /etc/cron.d/nomad-autoscale
# Run every minute with randomized sleep to avoid thundering herd
* * * * * root sleep $((RANDOM \% 15)) && /opt/herobids/infra/hetzner/scripts/scale-out.sh >> /var/log/nomad-autoscale.log 2>&1
```

### Safety Guarantees

1. **Flock serialization**: only one Terraform operation runs at a time. Lock file:
   `/var/run/nomad-autoscale.lock`.
2. **Cooldown**: prevents flapping by enforcing a minimum interval between scale-out events.
   Cooldown file: `/var/run/nomad-autoscale-last-scale-out`.
3. **Max node cap**: `max_agent_nodes` is a hard ceiling — the autoscaler will never
   provision beyond it.
4. **Safe node naming**: agent nodes are named `${server_name}-agent-${index+1}`.
   Terraform's `count.index` ensures stable identification — adding nodes appends,
   reducing nodes removes from the end. No mid-list destruction.
5. **Dry-run mode**: `--dry-run` shows what WOULD happen without making changes.
6. **No secrets in scripts**: all credentials come from environment variables or
   the Terraform tfvars file. Scripts accept config via env vars with sensible defaults.
7. **TOCTOU-safe cooldown**: the cooldown check is re-evaluated inside the flock
   critical section, preventing a race where two concurrent invocations both pass
   the initial cooldown check and scale out back-to-back.

### Nightly Scale-In (Phase 7)

A conservative nightly scale-in routine reduces idle agent nodes down to `min_agent_nodes`,
running at a configured time (default: 3 AM UTC). The scale-in policy is designed to never
interrupt active agent workloads.

**Safety rules (from plan):**
- Never kill active agent allocations to reach the floor.
- Mark candidate nodes ineligible for new placements first.
- Drain only nodes that are idle (zero running allocations) — nodes with active agents are skipped.
- Stop draining when `min_agent_nodes` is reached.

**Configuration:**

| Variable | Default | Description |
|---|---|---|
| `enable_scale_in` | `false` | Feature flag — must be `true` for nightly scale-in |
| `scale_in_drain_deadline_seconds` | 600 | Max seconds to wait for a draining node to empty |
| `scale_in_max_nodes_per_run` | 1 | Max nodes to drain per nightly run |
| `scale_in_time_utc` | `"3"` | UTC hour for nightly scale-in (0-23) |

**How it works:**

```
┌──────────────────────────────────────────────────────┐
│  systemd timer (daily, 3 AM UTC)                     │
│    │                                                  │
│    ▼                                                  │
│  scale-in.sh                                         │
│    │                                                  │
│    ├─ 1. Check ENABLE_SCALE_IN == true               │
│    ├─ 2. Read current agent_node_count               │
│    ├─ 3. If current ≤ min_agent_nodes → skip         │
│    ├─ 4. List eligible agent nodes                   │
│    ├─ 5. For each node: check if idle (0 running)    │
│    ├─ 6. Mark idle candidates ineligible             │
│    ├─ 7. Drain idle candidates                       │
│    ├─ 8. Wait for drain to complete                  │
│    ├─ 9. Acquire flock (same lock as scale-out)      │
│    └─ 10. terraform apply -auto-approve              │
│           -var agent_node_count=N - 1                │
└──────────────────────────────────────────────────────┘
```

```bash
# Dry-run to see what would be scaled in
/opt/herobids/infra/hetzner/scripts/scale-in.sh --dry-run

# Manual scale-in (respects all safety rules)
ENABLE_SCALE_IN=true /opt/herobids/infra/hetzner/scripts/scale-in.sh

# Manual scale-in with custom max nodes per run
ENABLE_SCALE_IN=true NOMAD_SCALE_IN_MAX_NODES_PER_RUN=3 \
  /opt/herobids/infra/hetzner/scripts/scale-in.sh
```

**Safety property:** a node that still has running allocations after the drain deadline
is NOT destroyed. The routine logs a warning and leaves the node in the cluster.
Operators should investigate stuck allocations manually.

### Placement-Failure Safety Net (Phase 7)

The placement-failure watcher (`check-placement-failures.sh`) detects repeated Nomad
evaluation failures caused by exhausted cluster resources and triggers emergency
scale-out via `scale-out.sh --safety-net`. This is a reactive safety net that catches
capacity exhaustion missed by the proactive capacity-check loop (e.g., a sudden surge
of agent launches that outpaces the polling interval).

**How it works:**

```
┌──────────────────────────────────────────────────────┐
│  systemd timer (every 120s)                          │
│    │                                                  │
│    ▼                                                  │
│  check-placement-failures.sh                         │
│    │                                                  │
│    ├─ 1. Poll GET /v1/evaluations from Nomad         │
│    ├─ 2. Filter blocked evals with resource keywords │
│    ├─ 3. Count blocked evals within time window      │
│    ├─ 4. If count > threshold → ALERT                │
│    ├─ 5. Check safety-net cooldown                   │
│    ├─ 6. Record trigger timestamp                    │
│    └─ 7. Trigger: scale-out.sh --bypass-cooldown     │
│          --force (shared flock, TOCTOU-safe)         │
└──────────────────────────────────────────────────────┘
```

**Configuration:**

| Variable | Default | Description |
|---|---|---|
| `placement_failure_window_seconds` | 300 | Lookback window for counting blocked evals |
| `placement_failure_threshold` | 5 | Blocked evals in window to trigger safety-net |
| `placement_failure_cooldown_seconds` | 600 | Min seconds between safety-net triggers |

```bash
# Dry-run to see what the safety net would do
/opt/herobids/infra/hetzner/scripts/check-placement-failures.sh --dry-run

# Manual safety-net check
NOMAD_PLACEMENT_FAILURE_THRESHOLD=3 \
  /opt/herobids/infra/hetzner/scripts/check-placement-failures.sh

# View placement-failure watcher logs
journalctl -u nomad-placement-failure-watcher -n 50
```

Both the scale-in routine and placement-failure safety net share the same `flock` lockfile
as `scale-out.sh`, ensuring only one Terraform operation (scale-out, scale-in, or
safety-net) runs at a time.

### Admin Alerting (Phase 8)

The autoscaler sends email alerts to the default admin when repeated scaling failures
occur, preventing silent cluster capacity degradation.

**Alert thresholds:**

| Trigger | Description |
|---|---|
| 3 consecutive scale-loop failures | Any scale-out or scale-in failure increments a counter. On the 3rd consecutive failure, an alert is sent. |
| Repeated safety-net failures | If the placement-failure watcher triggers scale-out but the safety-net itself fails, the counter increments. |
| No ready Nomad client nodes | The cluster has zero ready nodes — scaling is impossible. |

**State files:**

| File | Purpose |
|---|---|
| `/var/run/nomad-autoscale-failure-count` | Consecutive failure counter. Incremented on each failure, reset to 0 on any successful scale operation. |
| `/var/run/nomad-autoscale-last-alert` | Timestamp of last sent alert. Enforces rate limiting (default: 1 alert/hour). |

**How it works:**

```
┌──────────────────────────────────────────────────────┐
│  Any autoscale failure (scale-out, scale-in,         │
│  safety-net, capacity check)                         │
│    │                                                  │
│    ▼                                                  │
│  alert_failure()                                     │
│    │                                                  │
│    ├─ Increment failure counter                      │
│    ├─ If counter < threshold → return (no alert)     │
│    ├─ Check alert rate limit → skip if too soon      │
│    └─ build_alert_context() + send_alert()           │
│         ├─ Environment (staging/production)          │
│         ├─ Failure type and reason                   │
│         ├─ Current node count                        │
│         ├─ Recent Nomad eval errors (last 5)         │
│         ├─ Nomad capacity snapshot                   │
│         ├─ Terraform state info                      │
│         └─ Recent autoscale log tail                 │
│                                                      │
│  On success:                                         │
│    clear_failure_count()                             │
│      └─ Optionally send recovery email               │
└──────────────────────────────────────────────────────┘
```

**SMTP configuration:**

Alerts are sent via one of three backends, tried in order:

1. `sendmail` (available with `bsd-mailx` package, installed by cloud-init)
2. `mail` / `mailx` command
3. `curl` SMTP relay (direct connection to an SMTP server)

If none are configured, alerts fall back to `logger` (syslog).

| Variable | Default | Description |
|---|---|---|
| `alert_failure_threshold` | 3 | Consecutive failures before alert |
| `alert_rate_limit_seconds` | 3600 | Min seconds between alerts (1 hour) |
| `alert_send_recovery` | `"false"` | Send recovery email on resume |
| `alert_smtp_host` | `""` | SMTP relay hostname (empty = use sendmail/logger) |
| `alert_smtp_port` | 587 | SMTP relay port |
| `alert_smtp_use_tls` | `"true"` | Use TLS for SMTP connection |
| `alert_from` | `""` | From address for alert emails |
| `alert_to` | `""` | Recipient address (default admin) |

**SMTP configuration example (terraform.tfvars):**

```hcl
# Mailgun or similar SMTP relay
alert_smtp_host     = "smtp.mailgun.org"
alert_smtp_port     = 587
alert_smtp_use_tls  = "true"
alert_from          = "herobids-alerts@mg.yourdomain.com"
alert_to            = "admin@yourdomain.com"
alert_send_recovery = "true"
```

**Testing alert delivery:**

```bash
# Dry-run: preview alert content without sending
/opt/herobids/infra/hetzner/scripts/send-alert.sh --test --dry-run

# Send a test alert to verify email delivery
/opt/herobids/infra/hetzner/scripts/send-alert.sh --test

# Test recovery alert
/opt/herobids/infra/hetzner/scripts/send-alert.sh --recovery

# Send a custom alert
/opt/herobids/infra/hetzner/scripts/send-alert.sh \
  --type "manual_test" \
  --reason "Operator-triggered test alert."
```

**Inspecting alert state:**

```bash
# View current failure count
cat /var/run/nomad-autoscale-failure-count

# View last alert timestamp
cat /var/run/nomad-autoscale-last-alert

# Manually reset failure counter (if you've fixed the issue)
echo "0" > /var/run/nomad-autoscale-failure-count

# View alert logs in journal
journalctl -t nomad-autoscale-alert -n 50
```

**Manual recovery procedures:**

When an alert is received, follow these steps:

1. **Check autoscale logs:**
   ```bash
   ssh root@<control-plane-ip>
   tail -100 /var/log/nomad-autoscale.log
   journalctl -u nomad-autoscale -u nomad-scale-in -u nomad-placement-failure-watcher -n 100
   ```

2. **Verify Nomad cluster health:**
   ```bash
   nomad server members
   nomad node status
   nomad job status
   ```

3. **Check Terraform state:**
   ```bash
   cd /opt/herobids/infra/hetzner
   terraform plan
   ```

4. **Common recovery actions:**
   - **Terraform state lock:** If a previous `terraform apply` was interrupted, remove the lock:
     ```bash
     terraform force-unlock <LOCK_ID>
     ```
   - **Failed agent node:** If a newly provisioned node didn't join the cluster, check its cloud-init:
     ```bash
     ssh root@<agent-ip> 'tail -100 /var/log/cloud-init-output.log'
     ```
   - **Stuck scale-in drain:** If a draining node has stuck allocations, force-stop them:
     ```bash
     nomad alloc stop <alloc-id>
     ```
   - **Manual scale-out:** If the autoscaler is down, scale manually:
     ```bash
     cd /opt/herobids/infra/hetzner
     terraform apply -auto-approve -var "agent_node_count=<N+1>"
     echo "<N+1>" > /var/run/nomad-autoscale-node-count
     ```
   - **Reset alert state after manual fix:**
     ```bash
     echo "0" > /var/run/nomad-autoscale-failure-count
     ```

5. **Verify recovery:** After fixing the issue, wait for the next autoscale cycle or trigger one manually:
   ```bash
   /opt/herobids/infra/hetzner/scripts/scale-out.sh --dry-run
   /opt/herobids/infra/hetzner/scripts/scale-out.sh
   ```

### Scripts Reference (Phase 8)

| Script | Purpose |
|---|---|
| `scripts/alert-common.sh` | Shared alert functions: failure tracking, context builder, email sending |
| `scripts/send-alert.sh` | Standalone CLI for testing and manually triggering alerts |

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
- Terraform configuration (`main.tf`, `variables.tf`, `cloud-init.yaml`, `cloud-init-nomad-client.yaml`)
- Docker base compose file (`docker-compose.yaml`)
- Codebase (deployed from the same git repo and branch)

Environment differentiation comes from `terraform.tfvars` values (server name, domain, compose
overlay selection, network IP range, agent node count) and environment-specific `.env` files.
Per-environment `staging.tfvars` and `production.tfvars` templates are provided for clarity.

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
# Option A: Single-file setup (traditional)
cp terraform.tfvars.example terraform.tfvars
# edit terraform.tfvars — set environment = "production", fill in secrets

# Option B: Per-environment tfvars (recommended for multi-env clarity)
cp production.tfvars.example production.tfvars
# edit production.tfvars — fill in hcloud_token, ssh_public_key_path, deploy_ssh_private_key, git_repo_url

# 2. Provision the server (Terraform init + plan + apply)
# With Option A:
./scripts/provision.sh
# With Option B:
./scripts/provision.sh --env production --var-file production.tfvars

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
# Option A: Edit terraform.tfvars for staging
cp terraform.tfvars.example terraform.tfvars
# edit terraform.tfvars:
#   environment = "staging"
#   server_name = "herobids-staging"   # optional — follows convention
#   app_domain  = "staging.openaidom.com"

# Option B: Use per-environment tfvars (recommended)
cp staging.tfvars.example staging.tfvars
# edit staging.tfvars — fill in secrets, agent_node_count = 1 for Nomad

# 2. Provision the staging server
# With Option A:
./scripts/provision.sh --env staging
# With Option B:
./scripts/provision.sh --env staging --var-file staging.tfvars

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

Each environment needs its own set of variable values because each points to a
different server, domain, network IP range, lifecycle policy, and agent node pool.
There are two supported approaches:

**Approach A: `--var-file` (recommended for Phase 2+).**

Use per-environment tfvars files directly. No symlinks needed.

```bash
cd infra/hetzner

# Provision staging
cp staging.tfvars.example staging.tfvars
# edit staging.tfvars with staging values
./scripts/provision.sh --env staging --var-file staging.tfvars

# Provision production
cp production.tfvars.example production.tfvars
# edit production.tfvars with production values
./scripts/provision.sh --env production --var-file production.tfvars
```

The `--var-file` flag is passed through to `terraform plan` and `terraform apply`.
Ad-hoc terraform commands must also include workspace selection and `-var-file`:

```bash
terraform workspace select staging && terraform plan -var-file=staging.tfvars
terraform workspace select staging && terraform output -var-file=staging.tfvars
```

**Approach B: Symlink (legacy, simpler for single-env workflows).**

> **Note:** With workspaces, Approach A (`--var-file`) is recommended. The symlink approach still works but workspace selection handles state isolation automatically.

Keep source-of-truth tfvars files and symlink the active one as `terraform.tfvars`.

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
| **Production** | `openaidom.com` | A | Production server IP |
| | `www.openaidom.com` | A (or CNAME → `openaidom.com`) | Production server IP |
| | `app.openaidom.com` | A (or CNAME → `openaidom.com`) | Production server IP |
| **Staging** | `staging.openaidom.com` | A | Staging server IP |

> The production Caddyfile also handles `www.openaidom.com` and `app.openaidom.com` as
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
curl -svI https://staging.openaidom.com 2>&1 | grep -i "subject\|issuer\|expire"
```

If the certificate doesn't issue within a few minutes of the first HTTPS request:
- Verify DNS propagation: `dig staging.openaidom.com` should return the server IP.
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

# SSH into the server (with workspaces: select the workspace first, then read output)
terraform workspace select staging
ssh root@$(terraform output -raw server_ipv4)
# Or use the deploy scripts which handle this automatically:
./scripts/logs.sh --env staging

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
curl -sf https://staging.openaidom.com/health
```

## Smoke-Test Checklist

After every staging deploy, run the smoke-test checklist to verify the environment is
healthy before using it for pre-production validation.

See the full runbook: **[Staging Smoke-Test Checklist](../../docs/runbooks/staging-smoke-test.md)**

Quick reference:

| # | Check | Expected |
|---|-------|----------|
| 1 | `curl -sf https://staging.openaidom.com/health` | HTTP 200 |
| 2 | Open `https://staging.openaidom.com` in browser | Page loads, no cert errors |
| 3 | OAuth login flow | Redirects use staging domain |
| 4 | Billing page | Renders without errors |
| 5 | `./scripts/logs.sh --env staging -- worker` | No startup guard failures |
| 6 | Telegram webhook (if configured) | Bot responds to messages |
| 7 | DB migrations | `docker compose ... run --rm migrate` succeeds |

## Orchestration Rollout & Runbooks (Phase 9)

The Nomad-based agent orchestration feature (004-orchestration) has dedicated
runbooks for each environment. These cover the full validation checklist: agent
lifecycle through Nomad, autoscaling, alerting, rollback, and troubleshooting.

| Runbook | Environment | Purpose |
|---|---|---|
| **[Staging Orchestration Runbook](../../docs/features/2026/07/08/004-orchestration/004-staging-runbook.md)** | Staging | End-to-end validation of all orchestration flows before production rollout |
| **[Production Orchestration Runbook](../../docs/features/2026/07/08/004-orchestration/005-production-runbook.md)** | Production | Rollout guide with explicit rollback procedure to local-Docker runtime mode |

### Quick Reference: Nomad Commands

```bash
# Cluster health
nomad server members
nomad node status
nomad node status -verbose

# Agent job management
nomad job status -namespace=herobids-agents
nomad alloc status -namespace=herobids-agents <alloc-id>

# Autoscale systemd control
systemctl list-timers nomad-autoscale.timer nomad-scale-in.timer nomad-placement-failure-watcher.timer
systemctl status nomad-autoscale.service

# Autoscale manual operations
/opt/herobids/infra/hetzner/scripts/scale-out.sh --dry-run
/opt/herobids/infra/hetzner/scripts/scale-out.sh --force
/opt/herobids/infra/hetzner/scripts/scale-in.sh --dry-run
/opt/herobids/infra/hetzner/scripts/check-nomad-capacity.sh --json | jq .

# Alert testing
/opt/herobids/infra/hetzner/scripts/send-alert.sh --test
/opt/herobids/infra/hetzner/scripts/send-alert.sh --test --dry-run

# Unified autoscale logs
journalctl -u nomad-autoscale -u nomad-scale-in -u nomad-placement-failure-watcher -n 100
tail -f /var/log/nomad-autoscale.log
```

### Rollback to Docker Mode

If the Nomad orchestration path is compromised, switch the worker back to
local-Docker mode and stop autoscale timers:

```bash
ssh root@<control-plane-ip> <<'EOF'
cd /opt/herobids
sed -i 's/^RUNTIME_BACKEND=nomad$/RUNTIME_BACKEND=docker/' .env.prod  # or .env.staging
docker compose -f docker-compose.yaml -f docker-compose.prod.yaml up -d --force-recreate worker
systemctl stop nomad-autoscale.timer nomad-scale-in.timer nomad-placement-failure-watcher.timer
systemctl disable nomad-autoscale.timer nomad-scale-in.timer nomad-placement-failure-watcher.timer
EOF
```

See the production runbook for the full rollback procedure including agent node drain
and re-enable steps.

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
