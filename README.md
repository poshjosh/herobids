# herobids

Make using AI-powered agents as simple as describing what you want. No expertise required, no infrastructure to manage — just idea/intention in, outcomes out.

We are foremost an agentic platform. We offer agents as a service. We use skills to give agents expertise to work for users. Our first and core skill is crypto trading.

We offer LLMs and compute/server as a service for agentic use

AI-first algorithmic trading system. Supports multiple venues (Hyperliquid perpetuals, Bybit, Jupiter/1inch DEX swaps) with paper/shadow/live execution modes, real-time WebSocket market data, and configurable trading strategies.

## Prerequisites

- [Node.js](https://nodejs.org/) ≥ 22
- [pnpm](https://pnpm.io/) ≥ 10
- [Docker](https://docs.docker.com/get-docker/) with the Compose plugin

---

## Setup

```bash
# 1. Install dependencies
pnpm install

# 2. Copy environment template
cp .env.example .env
# Edit .env — at minimum set CREDENTIAL_ENCRYPTION_KEY:
#   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Config lives in `config/default.yaml`. Environment variables override any value — see that file for the full list.

---

## Running the stack

### Production (pre-built images)

Web UI is served on **http://localhost:5173**, API on **http://localhost:3000**.

```bash
# Start (first run builds images)
docker compose up -d --build

# Start (subsequent runs, no rebuild)
docker compose up -d

# Stop and remove containers
docker compose down
```

### Development (hot-reload)

Source is bind-mounted; saving a file restarts the relevant service automatically.
Web UI is served on **http://localhost:8080** (override with `WEB_PORT=<port>`), API on **http://localhost:3000**.

```bash
# Start (first run, or after source changes that require a rebuild)
docker compose -f docker-compose.yaml -f docker-compose.dev.yaml up -d --build

# Start (subsequent runs)
docker compose -f docker-compose.yaml -f docker-compose.dev.yaml up -d

# Stop and remove containers
docker compose -f docker-compose.yaml -f docker-compose.dev.yaml down
```

---

## Agent image

The agent runtime runs as a separate Docker image (`herobids-agent:latest`) that is **not** built by `docker compose up --build`. It must be built manually from the monorepo root whenever `apps/worker/src/agent.ts` or any of its dependencies change:

```bash
docker build -f docker/Dockerfile.agent -t herobids-agent:latest .
```

After rebuilding, stop and restart any running agent from the UI so the worker spawns a fresh container from the updated image.

### LLM configuration

Agent containers require an LLM provider and API key. Set these in `.env` before starting the stack:

```env
LLM_PROVIDER=openrouter          # openrouter | openai | anthropic
LLM_MODEL=anthropic/claude-sonnet-4-5
LLM_API_KEY_OPENROUTER=sk-or-...  # key for the chosen provider
```

The worker reads these from `.env` and forwards them to each spawned agent container. If `LLM_PROVIDER` or its key are missing, the worker (in docker mode) and the agent container both exit immediately with a fatal log rather than failing silently on the first reasoning tick.

---

## Building

```bash
# Build all packages (TypeScript → dist/)
pnpm build

# Type-check only (no emit)
pnpm lint
```

---

## Database migrations

Migrations run automatically as part of `docker compose up` via the `migrate` service.

To run them manually (e.g. against a local Postgres):

```bash
pnpm --filter @herobids/db run migrate
```

---

## Testing

### All tests (unit + integration + functional)

```bash
scripts/shell/tests/run-all-tests.sh
```

This script starts postgres and redis if they are not already running, runs all tiers, and tears down what it started.

### Unit tests

Pure logic, no external services required.

```bash
pnpm test
```

### Integration tests

Require a running postgres and redis (started automatically by the script above, or via `docker compose up -d postgres redis`).

```bash
pnpm test:integration
```

### Functional tests

Full API and worker in-process against a real database. Same requirements as integration tests.

```bash
pnpm test:functional
```

### E2E tests (Playwright)

Require the full stack to be running. Pass `--e2e` to the test script, which builds and starts everything automatically:

```bash
scripts/shell/tests/run-all-tests.sh --e2e
```

Or run Playwright directly against an already-running stack:

```bash
cd tests/e2e
BASE_URL=http://localhost:5173 pnpm test       # headless
BASE_URL=http://localhost:5173 pnpm test:headed # headed browser
BASE_URL=http://localhost:5173 pnpm test:ui     # Playwright UI mode
```

---

## Project structure

```
apps/
  api/        HTTP API (Hono) — instance CRUD, health, auth
  web/        Frontend (Vite + React)
  worker/     Long-running process — actors, stream pool, agent runtime

packages/
  domain/     Types, ports, value objects, config schemas (zero deps)
  engine/     Core trading logic: planner, risk gate, executors, position tracker
  strategy/   Strategy implementations
  venues/     Venue adapters (Hyperliquid, Bybit, Jupiter, 1inch), stream pool
  db/         Drizzle schema, migrations, repositories
  backtesting Backtesting engine and market data recorder
  llm/        LLM client and prompt utilities

config/       Operator YAML config
docs/         Feature specs, best practices, lessons, architecture notes
scripts/      Shell utilities and one-off TypeScript scripts
tests/e2e/    Playwright end-to-end journeys
```

Package dependency direction: `domain` ← `engine` ← `strategy` / `venues` / `db` ← `apps/*`
