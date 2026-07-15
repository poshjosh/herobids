# Cluster-Safe Agent Connectivity

This document defines which secrets, endpoints, and configuration values are:

- **Control-plane-only** — must NOT be passed to agent runtime containers
- **Agent-safe** — can be injected into agent runtime containers
- **Agent-substitutable** — the agent gets a different value than the control plane (e.g. private IP instead of Compose service name)

This separation is critical when agent containers run on remote Nomad nodes that are not on the same Docker network as the control plane.

## Connection Strings

| Env Var | Control-Plane Value | Agent Value | Notes |
|---------|-------------------|--------------|-------|
| `REDIS_URL` | `redis://redis:6379` (Compose service name) | `redis://<private-ip>:6379` (from `sharedServices.redisHost`) | Agent on remote node cannot resolve `redis` |
| `DATABASE_URL` | `postgres://herobids:herobids@postgres:5432/herobids` | `postgres://herobids:herobids@<private-ip>:5432/herobids` (from `sharedServices.postgresHost`) | Same reason — Compose names are local-only |

## How It Works

1. **Operator config** (`config/default.yaml` → `sharedServices`) defines the cluster-safe addresses:
   ```yaml
   sharedServices:
     redisHost: redis          # Compose name for local dev
     redisPort: 6379
     postgresHost: postgres    # Compose name for local dev
     postgresPort: 5432
     postgresUser: herobids
     postgresPassword: herobids
     postgresDatabase: herobids
   ```

2. **Local dev** (Docker Compose, `NODE_ENV=development`): Defaults work as-is. Agent containers are siblings on the same Compose network, so Compose service names resolve correctly.

3. **Staging/Production** (Nomad cluster): Override `sharedServices` via env vars to point to the control-plane host's private IP:
   ```bash
   SHARED_REDIS_HOST=10.0.0.5
   SHARED_POSTGRES_HOST=10.0.0.5
   ```
   These are set in `.env.staging` / `.env.prod` on the control-plane host and flow into agent runtime env via `buildAgentEnv()`.

4. **`buildAgentEnv()`** (in `runtime-lifecycle.ts`): When `sharedServices` is provided, constructs Redis and Postgres URLs from the cluster addresses. When absent, falls back to the worker's own connection strings.

## Firewall (UFW) Rules

The control-plane `cloud-init.yaml` opens Redis (6379) and Postgres (5432) from the private subnet:
```sh
ufw allow from ${private_subnet} to any port 5432 proto tcp
ufw allow from ${private_subnet} to any port 6379 proto tcp
```

Agent nodes (`cloud-init-nomad-client.yaml`) have `ufw default allow outgoing`, so no inbound rules are needed on agent nodes.

## Future Managed-Cloud Swap

To swap to managed cloud Redis/Postgres (e.g. Upstash Redis, Neon Postgres):

1. Update `sharedServices.redisHost` / `sharedServices.postgresHost` to the managed service endpoints
2. Update `sharedServices.postgresUser` / `sharedServices.postgresPassword` for the managed credentials
3. The agent-node bootstrap logic (`cloud-init-nomad-client.yaml`) does NOT change — it doesn't embed any shared-service addresses
4. Remove the UFW rules for ports 5432/6379 from `cloud-init.yaml` (they're no longer needed)

## Secrets Classification

### Control-Plane-Only (NEVER pass to agent runtimes)

These secrets are used by the worker/API and must not be exposed to agent containers:

| Secret / Env Var | Reason |
|-----------------|--------|
| `AUTH_JWT_SECRET` | JWT signing key — agent has no auth responsibility |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | OAuth credentials |
| `TELEGRAM_BOT_TOKEN` | Alerting bot — agent should not send alerts |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | SES email sending credentials |
| `BILLING_PRIMARY_PROVIDER` secrets (Stripe, Creem keys) | Payment processing |
| `BIRDEYE_API_KEY` | Market data API — worker proxies market data for agents |
| `COINMARKETCAP_API_KEY` | Market data API — same reason |
| `DEPLOY_SSH_PRIVATE_KEY` | Infrastructure access |
| `DOCKER_HOST` | Docker socket — agent runs its own Docker, not the control plane's |
| `DOCKER_NETWORK` | Compose network name — irrelevant for remote agent |
| `AUTH_PUBLIC_BASE_URL` | Not needed in agent |
| `AUTH_FRONTEND_ORIGIN` | Not needed in agent |

### Agent-Safe (safe to inject into agent runtimes)

These are passed to agent containers via `buildAgentEnv()`:

| Env Var | Purpose |
|---------|---------|
| `AGENT_ID` | Agent identity |
| `SESSION_ID` | Current session |
| `AGENT_CONFIG` | Agent configuration JSON |
| `TOOL_POLICY` | Tool policy overrides |
| `AGENT_RUNTIME_CONFIG_JSON` | Runtime parameters |
| `AGENT_WORKSPACE_ROOT` | Working directory inside container |
| `LLM_PROVIDER` | Which LLM provider to use |
| `LLM_BASE_URL` | LLM API base URL |
| `LLM_MODEL` | Model identifier |
| `LLM_MAX_TOKENS` | Token limit |
| `LLM_TIMEOUT_MS` | Request timeout |
| `TICK_INTERVAL_MS` | Reasoning loop interval |
| `HEARTBEAT_INTERVAL_MS` | Heartbeat cadence |
| `LLM_SERVER_COST_USD_PER_HOUR` | Cost tracking |
| `TRADING_HOURS_JSON` | When to be active |
| `MARKET_DATA_CONFIG_JSON` | Market data provider configs |
| `DEXSCREENER_BASE_URL` / `BINANCE_BASE_URL` | Market data endpoints |
| `MARKET_DATA_CONFIGURED` | Boolean flag |
| `LLM_API_KEY` (and provider variants) | LLM API keys — required for agent to call LLMs |
| `TAVILY_API_KEY` | Web search tool |
| `SCRAPFLY_API_KEY` | Forex Factory Cloudflare bypass (Scrapfly proxy) |
| `USAGE_BILLING_RATE_CARD` | Billing rate card |
| `USAGE_BILLING_RUNTIME_WINDOW_MS` | Billing window |
| `PROVIDERS_YAML` | Provider rate-card seeding |

### Agent-Substitutable (control-plane value differs from agent value)

| Env Var | Control-Plane | Agent Runtime | Why Different |
|---------|---------------|---------------|---------------|
| `REDIS_URL` | Compose service name / localhost | `sharedServices.redisHost`:private IP | Agent on remote node |
| `DATABASE_URL` | Compose service name / localhost | `sharedServices.postgresHost`:private IP | Agent on remote node |
