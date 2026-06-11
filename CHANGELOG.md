# Changelog

All notable changes to this project will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- More tools (2026-06-11): added task, reminder, memory, and document-reading tools, plus email fanout for allowed agent messages.

- Always-on market intelligence (2026-06-10): added leader-owned discovery polling, market monitor evaluation, wake coalescing, and market event protocol support.

- Web access tools (2026-06-11): added `search_web` and `browse_url` for Tavily-backed internet search and HTML page reading, plus the `research` skill, capability grants, SSRF/content-type safeguards, and agent runtime config wiring.

- Agent controls and cadence (2026-06-10): added configurable tick interval, capital, and LLM budget handling across API, web, and worker runtime.

- Improved connection and credential handling (2026-06-10): added guided provider-link setup from Mission Control and Create Agent, with a transactional setup endpoint and explicit trading provisioning.
- Web i18n (2026-06-10): full react-intl migration — locale provider, EN/AR/HI catalogs, locale selector in Settings, server-persisted preference, structured API error codes with interpolation params, activity event message keys, shared formatting helpers (`formatShortDate`, `formatCurrencyFromCents`). See ADR 002.
- `preferred_locale` column on `users` table (migration `0001_add_preferred_locale`): stores the user's chosen UI language; synced to client on session bootstrap.

### Changed

- **Migration squash (2026-06-10):** The 13 incremental migration files `0000_windy_serpent_society` through `0012_execute_code_programming_skill` were replaced with a single baseline (`0000_baseline.sql`) that represents the full schema at this point. Migration `0001_add_preferred_locale` is additive on top.
  - **Fresh databases:** run `pnpm --filter @herobids/db run migrate` as normal.
  - **Existing databases that ran the old migrations:** run `bash scripts/shell/ops/apply-db-squash-fixup.sh` once, then run `pnpm --filter @herobids/db run db:migrate`. The helper records the new baseline hash in `drizzle.__drizzle_migrations` so the squashed baseline is skipped and `0001_add_preferred_locale` can apply safely.

### Fixed

- Agent runtime policy (2026-06-09): added a dedicated container runtime policy schema so forwarded LLM retry/scout/thinking settings are validated and preserved inside the agent runtime
- Hyperliquid venue accounts (2026-06-09): account creation now caches the unauthenticated probe result instead of overstating authenticated/live capability when a credential is merely linked

### Added

- Agent evolution epics (2026-06-08):
  - **Epic A — Cost reduction:** prompt reordering for cache hits; regime gate; context-hash gate; scout/judge split with cost-profile budgets; incremental context diffing
  - **Epic B — Intelligence:** richer runtime state (portfolio, venue, P&L, drawdown); reworked prompt assembly order; portfolio/position/event context blocks; progress score
  - **Epic C — Market data:** operator-config expansion for all providers; unified `@herobids/market-data` provider registry with request-class model and per-class rate limits; `search_tokens` and `check_regime` agent tools; `GeckoTerminal` and Hyperliquid/Bybit intelligence endpoints
  - **Epic D — Reliability:** LLM error taxonomy; retry with 429-aware backoff; self-healing tick loop with failure-count backoff; capability degradation when dependencies are unavailable; tool circuit breaker across ticks; reasoning-content stripping hardened
- Agent tool improvements (2026-06-08):
  - Bot lifecycle tools wired in-process (create/start/stop/delete); `submit_decision` renamed from `decision_submit`; read tools for analytics and positions; skill definitions updated
- Trading binding — native bot startup (2026-06-08): bots started directly from the engine at decision time without a separate actor dispatch round-trip
- Tool registry (2026-06-09): `ToolDefinition` made provider-neutral (`name`, `description`, `inputSchema`); `ToolRegistry.getDefinitions()` returns the neutral shape; `AgentTool` unchanged
- Structured tool calling (2026-06-09): LLM client extended with provider-neutral tool definitions, tool-call requests/responses, and Anthropic native support; judge path replaced with a bounded `runStructuredToolLoop` helper; prompt JSON-tool-call instruction removed; `provider.invalid_tool_args` error code with `fatal` classification
- Scout tools and runtime hardening (2026-06-09): scout phase wired to the bounded structured tool loop with read-only tool access; agent signal handlers registered before startup awaits and the first tick; `list_positions` restored a non-null bot ID contract with invariant enforcement at the worker tool boundary

- Feature 016 — Agent interactivity:
  - `PUT /agents/:id` — reconfigure a stopped agent (replaces config in-place)
  - `POST /agents/:id/message` — send a freeform message into an agent's inbound Redis stream
  - `GET /agents/:id/memory` — read agent memory from Redis hash (`agent:memory:{id}`); values JSON-parsed on read
  - `GET /agents/:id/prompt` — read the compiled system prompt cached in Redis (`agent:prompt:{id}`)
  - `GET /agents/telegram-bot` — return the operator's Telegram bot username (if configured)
  - `POST /agents/verify-telegram` — verify a Telegram chat link token and bind `telegramChatId` to user
  - `POST /api/telegram/webhook` — public Telegram webhook handler; validates `x-telegram-bot-api-secret-token`
  - Export endpoints: `GET /agents/:id/exports/trades`, `/exports/journal`, `/exports/costs`, `/exports/sessions` (CSV), `/exports/config`, `/exports/bundle` (JSON)
  - Worker: `set_memory` tool added to `BASE_SKILL.requiredTools`; worker stores memory via `JSON.stringify`; compiled system prompt persisted to Redis with 1 h TTL on each tick
- Feature 017 — Analytics, AI endpoints, Skills, and Datasets:
  - `GET /analytics` — aggregated portfolio analytics (PnL by day/week/month, win rate, drawdown, Sharpe); filters: agentId, botId, venue, symbol, sessionId, date range
  - `GET /ai/available-models` — list providers enabled by operator config; respects generic `LLM_API_KEY` + `llm.provider` deployment pattern without advertising all 8 providers
  - `POST /ai/generate-config` — generate blueprint `configData` from freeform text via LLM; rate-limited 10/min per user
  - `POST /ai/analyze-portfolio` — AI narrative summary of open/closed positions and P&L
  - `POST /ai/explain-signal` — AI explanation of a trade signal with optional candle context
  - `PATCH /settings/ai-model` — save per-user `primary`/`fallback1`/`fallback2` model preferences; preferences only applied when the provider has its own dedicated API key
  - `GET /skills`, `POST /skills`, `GET /skills/:id`, `PUT /skills/:id`, `DELETE /skills/:id`, `POST /skills/:id/fork` — skill CRUD and fork; visibility: `private`/`public`/`built-in`
  - `GET /datasets`, `POST /datasets/upload` (CSV/plain), `POST /datasets/fetch`, `DELETE /datasets/:id` — dataset management
  - DB: `users.ai_model_config` JSONB column; `datasets` table with FK cascade and status enum
  - Migration: `0004_features_016_017.sql`
- Feature 5a — Bybit and 1inch venue support
- Feature 5b — Telegram alerting
- Feature 5c — broader auth coverage
- Feature 5d — autonomous agent tooling
- Feature 5e — frontend dashboard
- Feature 5f — billing
- UI simplification
- Full-stack Docker Compose
- Rename `tradingInstanceId`
- Plan quota fix
- Bot data surface
- Agent data surface
- Billing ledger sessions
- Exports
- Admin websocket
- Frontend refresh
- Capability-platform API redesign
- Blueprints: DELETE, publish, and unpublish wrapped in `pg_advisory_xact_lock` transactions to prevent concurrent mutation
- Schemas: `blueprintId` and `config` are mutually exclusive in `CreateInstanceSchema`

- API/worker: pino-pretty dev logging (LOG_FORMAT=pretty or NODE_ENV=development)
- docker-compose: API healthcheck; web depends on api:service_healthy
- docker-compose.dev: LOG_FORMAT=pretty for dev services
- scripts/seed-admin: seeds first admin user; requires ADMIN_EMAIL + ADMIN_PASSWORD;
  ADMIN_PLAN_ID optional (defaults to 'free')
- scripts/rate-limit-load-test: concurrent load test scaffold; ENDPOINT_IS_RATE_LIMITED env flag
- Functional tests: auth + agents API (apps/api/src/__tests__/functional/)
- Worker integration tests: session lifecycle (apps/worker/src/__tests__/integration/)
- E2E: Playwright setup + 6 journey specs (tests/e2e/)
- Web: responsive layout — mobile topbar, sidebar overlay, auth-card, page-shell classes
- vitest: exclude tests/e2e/** from vitest run
- root package.json: test:functional script"
- Initial commit