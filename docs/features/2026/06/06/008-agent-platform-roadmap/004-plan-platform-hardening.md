# Plan 4: Platform Hardening

**Phase:** 4
**Status:** `done`
**Depends on:** [Phase 1 — Foundation Cleanup](./001-plan-foundation-cleanup.md), [Phase 2 — Real Agent Runtime](./002-plan-real-agent-runtime.md)
**Roadmap:** [000-roadmap.md](./000-roadmap.md)

## Progress

| Step | Description | Status |
|---|---|---|
| 4.1 | Full docker-compose stack (all services) | `done` — api, worker, web, postgres, redis, docker-proxy, migrate, nginx all wired |
| 4.2 | `docker-compose.dev.yaml` hot-reload overrides | `done` — bind mounts, tsx/vite dev, LOG_FORMAT=pretty |
| 4.3 | First admin user seeding | `done` — `scripts/ts/seed-admin.ts`; ADMIN_EMAIL + ADMIN_PASSWORD + optional ADMIN_PLAN_ID |
| 4.4 | Functional API tests (agents, bots, decisions, send_message) | `done` — `apps/api/src/__tests__/functional/` |
| 4.5 | Worker integration tests (session lifecycle) | `done` — `apps/worker/src/__tests__/integration/` |
| 4.6 | E2e user-acceptance tests (6 key journeys) | `done` — `tests/e2e/journeys/01–06` with Playwright |
| 4.7 | Rate limiting load test script + report template | `done` — `scripts/ts/rate-limit-load-test.ts` |
| 4.8 | Dev pretty logs / prod JSON logs | `done` — pino-pretty via LOG_FORMAT=pretty or NODE_ENV=development |
| 4.9 | Responsive layout (agents page, agent detail, bots page, auth) | `done` — `.layout-root`, mobile sidebar, auth-card, page-shell-responsive |
| 4.10 | `pnpm lint` passes, all tests pass in CI | `done` |

## Goal

The platform is production-ready: deployable as a complete stack with a single command, seeded with a first admin user, covered by automated tests, and validated under realistic load.

## Context

Current gaps:
- `docker compose up` starts only postgres and redis — api, web, and worker are not containerised in the compose file (they have Dockerfiles but are not wired)
- No first/admin user seeding
- No functional, integration, or e2e user-acceptance tests
- Rate limiting exists but has not been validated under concurrent agent load
- Logs are JSON in all environments (acceptable for production but poor for local dev)
- Layout is not responsive

---

## Deliverables

### 1. Full docker-compose Stack

File: `docker-compose.yaml`

Add all services so `docker compose up` starts the complete platform:

| Service | Image | Notes |
|---|---|---|
| `postgres` | postgres:16-alpine | Already present |
| `redis` | redis:7-alpine | Already present |
| `docker-proxy` | tecnativa/docker-socket-proxy | Added in Phase 2 |
| `api` | Dockerfile (or built image) | HTTP API |
| `worker` | Dockerfile | BullMQ worker + agent manager |
| `web` | Dockerfile (or built image) | React frontend |
| `migrate` | docker/Dockerfile.migrate | Runs migrations before api/worker start |
| `caddy` or `nginx` | Reverse proxy | Routes `/api` to api, `/` to web |

Startup order:
```
postgres → migrate → api + worker
redis → worker
docker-proxy → worker (agent manager)
api + web → caddy/nginx
```

`depends_on` with `service_healthy` for postgres and redis before migrate runs.

Dev overrides file (`docker-compose.dev.yaml`) should:
- Mount source files as volumes for hot-reload
- Use `tsx` / `vite dev` instead of built images
- Expose ports directly (no reverse proxy needed locally)

### 2. First Admin User Seeding

Add a DB seed script or migration that inserts a default admin user if no users exist.

Options:
- A dedicated seed script `scripts/ts/seed-admin.ts` run manually or as a docker-compose `seed` service that runs once after migrate
- Environment variables: `ADMIN_EMAIL`, `ADMIN_PASSWORD` (hashed at seed time) — never committed, always via env

The admin user must own no agents or bots by default. It is a platform operator account used for initial setup and internal testing.

If `ADMIN_EMAIL` is not set, seeding is skipped with a clear log message — not a fatal error.

### 3. Functional And Integration Tests

The existing test suite covers unit-level logic. This phase adds:

#### 3a. API functional tests

File location: `tests/functional/` or `apps/api/src/__tests__/functional/`

Cover the key user flows end-to-end through the HTTP API (no browser):

- Auth: register, login, token refresh
- Agents: create, list, get, start, pause, resume, stop, relink, delete
- Bots: create, list, get, start, stop, update config
- Agent decisions: submit via message protocol, appear in decisions endpoint
- Agent send_message: broker delivers, appears in outbound messages

Use a real postgres instance (test database) and real Redis for these tests. Do not mock the DB or Redis.

#### 3b. Worker integration tests

Test the worker lifecycle with real infrastructure:

- Start agent → container launched (or stub in CI) → session created in DB
- Stop agent → container stopped → session closed in DB
- Agent crash → crash detected → safety alert fired → status updated

These tests should use `AGENT_RUNTIME_MODE=stub` in CI unless a Docker-in-Docker setup is available.

#### 3c. User-acceptance test scenarios

File location: `tests/e2e/` or reference [docs/tech/user-acceptance-tests.md](../../../tech/user-acceptance-tests.md)

Cover the key user journeys from the browser perspective using a headless browser (Playwright recommended):

1. Sign up → create an agent → link to a bot → start the agent → see heartbeat in UI
2. Agent submits a decision → decision appears in Recent Decisions card
3. Agent calls `send_message` → message appears in UI communication history
4. Platform safety alert fires → alert visible in UI
5. User pauses agent → agent pauses → user resumes → agent resumes
6. User deletes agent → agent stopped → removed from list

### 4. Rate Limiting Under Load

The current rate limiting covers market data and venue API calls. This phase validates it under realistic concurrent load.

**What to test:**

Simulate N agents (N = 5, 10, 20) all accessing market data simultaneously:
- Measure actual request rates per provider
- Confirm the rate limiter correctly throttles to the configured limit
- Confirm no provider returns 429 during the test window
- Confirm individual agents are not starved indefinitely

**Output:**
- A test script in `scripts/ts/rate-limit-load-test.ts`
- A markdown report template in `docs/test-reports/` for capturing results per run

These tests validate behaviour under load, not functionality. They should produce a repeatable report.

### 5. Log Format By Environment

Current state: all logs are structured JSON via pino in all environments.

Recommendation:
- Production: keep JSON (machine-parseable, compatible with log aggregators)
- Development: use pino-pretty (human-readable, colourised) — activated via `NODE_ENV=development` or a `LOG_FORMAT=pretty` env var

**Change:**
- `apps/api/src/` and `apps/worker/src/` — check for `LOG_FORMAT=pretty` or `NODE_ENV=development` at logger initialisation and configure pino transport accordingly
- `docker-compose.dev.yaml` — set `LOG_FORMAT=pretty` for api and worker services
- Do not install `pino-pretty` as a production dependency — `devDependencies` only

### 6. Responsive Layout

All pages must be usable on mobile and tablet viewports.

Priority order:
1. `/agents` page and agent detail page — primary operational surfaces
2. `/bots` page and bot detail page
3. Auth pages (login, register)
4. Navigation and layout shell

Use the existing Tailwind/CSS framework already in place. No new UI library needed.

---

## Exit Criteria

- [ ] `docker compose up` starts the complete platform (postgres, redis, docker-proxy, api, worker, web, migrate, reverse proxy)
- [ ] `docker compose -f docker-compose.yaml -f docker-compose.dev.yaml up` works for local development with hot-reload
- [ ] First admin user seeded if `ADMIN_EMAIL` env var is set
- [ ] Functional API tests pass for agents, bots, decisions, and send_message flows
- [ ] Worker integration tests pass for session lifecycle
- [ ] E2e user-acceptance tests cover the 6 key journeys
- [ ] Rate limiting load test script exists and produces a report
- [ ] Dev environment uses pretty log format; production uses JSON
- [ ] All primary pages are usable on mobile and tablet viewports

---

## Decision Log

Append-only. Record decisions made or changed during implementation, with date and reason.

| Date | Decision | Reason |
|---|---|---|
| 2026-06-04 | Bots page is a secondary surface, not a primary nav item | Core product is agent-first; users manage bots through agents, not directly |
- [ ] `pnpm lint` passes
- [ ] All tests pass in CI
