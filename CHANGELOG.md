# Changelog

All notable changes to this project will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## v0.0.28 - 2026-07-16

### Fixed

- **TechnicalConfig Zod defaults not applied at DB read boundary:** `scanBatchSize` and `scanIntervalMs` were `undefined` at runtime for all hybrid agents because `getUnifiedConfig()` returned raw JSONB without parsing through `TechnicalConfigSchema`. This caused the candle-fetching loop to never execute (`i += undefined` → `NaN`) while the scan timer ran at maximum speed (~1ms intervals from `setInterval(fn, undefined)`). Added `applyConfigDefaults()` helper that parses `technical` through `TechnicalConfigSchema` and `intelligence` through `IntelligenceConfigSchema` at the DB read boundary. (8 tests + 4-scenario smoke test added). See [docs/bug-reports/2026/07/16/003-technical-config-scan-defaults-not-applied-at-load.md](docs/bug-reports/2026/07/16/003-technical-config-scan-defaults-not-applied-at-load.md).

## v0.0.27 - 2026-07-16

### Fixed

- **Redis agent stream unbounded memory growth:** `XADD` calls on `agent:inbound:*`/`agent:outbound:*` streams never capped stream length, so streams grew indefinitely (hundreds of thousands of entries/agent within days), repeatedly exhausting staging server memory (90%+, one OOM-killed `redis-server`). Added a shared `AGENT_STREAM_MAXLEN` constant and applied `MAXLEN ~` to all 8 `XADD` call sites across `apps/api` and `apps/worker`. Also persisted `redis --maxmemory 512mb --maxmemory-policy allkeys-lru` in `docker-compose.yaml` as defense-in-depth (previously only applied ad hoc via `redis-cli` on the live server, so it did not survive container recreation). See [docs/bug-reports/2026/07/15/001-redis-agent-outbound-streams-unbounded-memory-exhaustion.md](docs/bug-reports/2026/07/15/001-redis-agent-outbound-streams-unbounded-memory-exhaustion.md).

## v0.0.26 - 2026-07-16

### Fixed

- Fixed telegram messaging by dropping `/api` from url prefix.
- **Hybrid agent `technical.filters` never populated:** All hybrid agents crashed on every scanner tick because `unifiedConfig.technical.filters` was never written during agent create/update. The API now derives `venue` and `venueType` from the agent's Hyperliquid connection provider and populates `filters` in both POST and PATCH handlers. PATCH also falls back to existing active connections when `connectionIds` are omitted. Added defensive `undefined` guard in `discoverCandidates` as belt-and-suspenders. (5 tests added)

### Added

- **Technical Scanner Data Inputs for Agents:** Wired market data sources (Hyperliquid asset contexts via `discoverCandidates`, Binance candles via `fetchCandles`) and per-agent `TechnicalConfig` into `AgentTradingActor`. Hybrid/scanner_gated agents now receive pre-scored signals from the technical scanner loop. Zero new files, zero schema changes — pure integration wiring in `apps/worker/src/index.ts`.
- **Scrapfly Proxy for Forex Factory (Cloudflare Bypass):** Route the Forex Factory economic-calendar scrape through Scrapfly's Scrape API with Anti-Scraping Protection (ASP) to bypass Cloudflare blocks on cloud/datacenter IPs. Generic `createScrapflyFetch()` helper in `@herobids/market-data` for future scrapers. Config at `marketData.scrapfly` (non-secret knobs only; API key follows `TAVILY_API_KEY` pattern — raw env passthrough). Bumped `forexFactory.requestTimeoutMs` from 15s to 60s to accommodate ASP latency.
- **Background Economic Calendar Refresh:** Decouple the economic calendar fetch from the agent tick loop. The worker process now runs a background interval (`refreshIntervalMs`, default 6h) that fetches via Scrapfly and writes to a shared Redis cache. Agent ticks read exclusively from cache (`cacheOnly` mode, sub-millisecond) — they never block on a network call for economic calendar data. Extracted `createLlmCalendarParser()` to `@herobids/market-data`. Removed `fetchHttp1` and Scrapfly wiring from the agent container.
- **Structured Economic Calendar Parsers:** Replaced fragile regex-based HTML table extraction with `node-html-parser` DOM parsing. Three parsers: `createDomCalendarParser()` (pure DOM, ~10ms, zero cost), `createLlmCalendarParser()` (refactored to use DOM for table selection), and `createFallbackCalendarParser()` (DOM first, LLM fallback — the default). Common case: DOM succeeds in <10ms with no LLM call. Uses actual Forex Factory class names (`calendar__table`, `calendar__row`, `universal-impact__impact-*`).

## v0.0.25 - 2026-07-14

### Added

- **Telegram Agent Slash Commands:** Full command surface for agent discovery, status, and lifecycle control via Telegram. 16 commands across 5 categories: Help (`/help`), Discovery (`/agents`, `/status`, `/info`, `/skills`, `/log`, `/connections`), Lifecycle (`/start`, `/pause`, `/resume`, `/stop`, `/restart`), Config (`/mode`, `/connect`, `/disconnect`), and Messaging (`/to`). Includes one-time setup link flow for secure connection creation without secrets in chat. Commands register via Bot API `setMyCommands` at startup. 54 new tests.

### Changed

- **Agent shadow mode:** Removed the admin-only restriction for selecting `shadow` execution mode in agent create/edit flows and agent API validation.
- **Execution mode UX:** Simplified agent execution mode of `live`, `paper`, and `shadow`. The frontend and public docs only show `Live` and `Test`. The API accepts `test` (maps it to either `shadow` or `paper`). `paper` and `shadow` remain available via the API. Updated i18n strings, public-facing glossary, user agreement, and internal tech glossary accordingly.
- **Connection requirement for live/shadow execution:** Creating or updating an agent into `live` or `shadow` execution mode now requires at least one granted connection, on both the API (create, PATCH, PUT) and the create-agent UI. Closes a gap where a venue-only selection with no granted connection could produce an agent with a venue-backed execution mode but no execution context to resolve at runtime. The create flow now sends the selected venue to the API so `test` can resolve to `shadow` even before a connection is granted, and the edit modal no longer risks clearing existing connections while they are still loading.

## v0.0.24 - 2026-07-13

### Added

- **Documents for Agents (v1):** Text-first document support for agents — upload documents via web UI or Telegram, automatically extracted and materialized into agent workspace. New `@herobids/documents` shared package, `agent_documents` DB schema, API endpoints, runtime materialization, Telegram document ingest, and shared PDF extraction. (10 of 11 rollout items complete; UI wiring pending.)

### Changed

- **Brand asset consolidation:** Removed duplicate light/dark wordmarks and compact marks. `BrandLogo` now uses a single `compact-mark.png` (dark-background icon) with CSS filter (`brightness(0)` / `brightness(0) invert(1)`) for dark/light surface visibility, and typographic text for the wordmark — eliminating the "logo + logo" duplication.
- **Favicon overhaul:** Replaced PNG favicon sets (which had poor contrast on light browser chrome) with a single set generated via RealFaviconGenerator from a solid navy-background 512px icon. Works on both light and dark browsers.
- **Platform Email Redesign (003):** Refined platform-authored email branding and structure.
  - Auth login-link email: "HeroBids" → "OpenAIdom" branding, added CTA button for sign-in, improved body copy with raw-link fallback.
  - Platform safety alerts: Telegram messages now say "OpenAIdom Safety Alert" instead of "HeroBids Safety Alert".
  - Added comprehensive test suite for `PlatformAlertService` (31 tests covering persistence, Telegram delivery, email delivery, dual-channel, event subject mapping, and edge cases).
  - Auth mailer tests now assert HTML content structure, CTA presence, and brand colors.
  - Wired `wordmark-dark.png` brand asset into email renderer via new `alerts.email.brandImageUrl` config field, falling back to typographic header when unset.
  - `PlatformAlertService`, `AgentMessageBroker` (billing), and `createAuthMailer` all pass `brandImageUrl` through to `renderEmail()`.
  - Default configs: staging → `staging.openaidom.com`, production → `openaidom.com`.

## v0.0.23 - 2026-07-13

### Fixed

- maintenance restart script

## v0.0.22 - 2026-07-13

### Added

- **OpenAIdom Brand Rollout (9 slices):** Introduced OpenAIdom as the customer-facing brand across the web app, platform-authored email, and public documentation while keeping internal engineering names unchanged.
  - Slice 1: Asset intake and brand contract (`apps/web/public/brand/`, `apps/web/src/brand/tokens.ts`)
  - Slice 2: Shared `BrandLogo` component (`apps/web/src/brand/BrandLogo.tsx`) — mark, wordmark, mark+wordmark, typographic fallback, light/dark variants
  - Slice 3: App shell (sidebar, mobile top-bar) and auth/public surfaces (login page, PublicLayout) switched to branded component
  - Slice 4: Browser metadata — favicon, `site.webmanifest`, document title, social/share meta tags
  - Slice 5: Theme token alignment — `--brand-*` hex tokens → `--color-*` aliases in `apps/web/src/styles.css`, teal-forward palette replaced with navy/indigo
  - Slice 6: Branded platform email shell (`packages/domain/src/email/renderer.ts`) with HTML + plain-text fallback
  - Slice 7: Auth login-link mail, billing notifications, and safety alerts migrated to branded renderer
  - Slice 8: Public docs and customer-facing copy — 13 markdown files updated; dual-label "OpenAIdom," for company/legal pages
  - Slice 9: Internal documentation — post-implementation asset map, cross-linked domain rollout plan, intentionally-preserved-names catalog, runbook verification, CHANGELOG entry (see [preserved-names catalog](./docs/features/2026/07/12/002-openaidom-brand-rollout/001-plan.md#intentionally-preserved-internal-herobids-names))

### Changed

- Evaluation narrative prompt now surfaces agent memory, watch state, and tool failure patterns from Redis snapshot without truncation, and asks targeted coverage/instrumentId questions.

## v0.0.21 - 2026-07-13

### Added
- Agent-direct protection alignment: native per-trade exit levels now count as active-session coverage, preventing repeated `open_position_uncovered` judge escalations.
- Canonical `instrumentId` preservation across agent-direct private-stream updates, restart rehydration, and decision intake.
- Truthful `list_positions` payload with separate `symbol`, `instrumentId`, `venue`, `stopLoss`, and `takeProfit` fields.
- Fail-closed rejection of unmatchable protective watches (`stop_loss`/`take_profit`/`exit` without instrument or position linkage).
- New `[NATIVE_PROTECTED]` and `[PROTECTED]` coverage labels in runtime context.

### Changed
- `watch_token` now rejects protective-purpose watches that cannot be linked to a canonical instrument or live position.
- Protective auto-link now succeeds only on exact canonical `venue + instrumentId` matching; symbol-based retry fallback removed.
- `parseWatch()` no longer repairs malformed structured watches by defaulting missing `purpose` to `'alert'` — `purpose` is now required in persisted structured watches.
- `list_positions` returns canonical `instrumentId` (nullable) instead of mislabeling `symbol` as `instrumentId`.
- `submit_decision` `stopLoss`/`takeProfit` descriptions updated to accurately reflect active-session-only protection scope.

### Fixed
- Agent-direct positions no longer lose canonical `instrumentId` through private-stream persistence, restart rehydration, or intake resolver rehydration.

## v0.0.20 - 2026-07-12

### Fixed

- google login
- cost benchmark

## v0.0.19 - 2026-07-11

### Added
- **Hybrid Mode Split (`capabilityMode` / `hybridMode`):** Replaced implicit hybrid derivation with explicit `capabilityMode` (`'intelligence'` | `'hybrid'`) and `hybridMode` (`'mixed'` | `'scanner_gated'`) fields on agents.
  - **Domain:** `CapabilityModeSchema`, `HybridModeSchema` with cross-field validation (hybrid requires technical config; intelligence rejects hybridMode).
  - **DB:** Migration 0040 stamps correct defaults on existing agents; repository applies `'mixed'` default at read/write time.
  - **API:** POST/PATCH accept and validate both fields with proper mode transitions and orphaned field cleanup.
  - **Runtime:** `scanner_gated` agents suppress non-scanner market wakes (watch_threshold, discovery_delta, regime_change); route all trading turns through hybrid evaluator; reminders/user messages still processed normally via scout/judge.
  - **Web UI:** Hybrid mode selector in agent form; wake sources hidden for scanner_gated agents; capabilityMode derived from technicalPreFilterEnabled + trading skill.
  - **Cleanup:** Removed dead `'technical'` and `'both'` capability mode values.
- **Adaptive Reasoning Toggle:** Per-agent `adaptScoutReasoning` / `adaptJudgeReasoning` booleans that control whether reasoning levels act as ceilings (adaptive, default) or fixed levels. When adaptive is off, `classifyTickThinking` and `applyReasoningCeiling` are skipped — giving deterministic, cost-predictable reasoning with zero runtime variance. Controls are exposed in Settings (all users) and automatically stamped into agent `runtimePolicyOverrides` at creation/update.
- **New-User Link + Unique Username:** Added optional registration affordance to the login-link-first auth screen
  - `users.username` column (non-null, unique) with migration
  - `New user` toggle on login page reveals optional username field
  - CTA changes to `Send registration link` when in new-user mode
  - Username validation (3-30 chars, lowercase letters/digits/underscores)
  - Username availability check + Redis reservation during link send
  - Auto-generated unique username with retry-on-conflict for unset usernames
  - Humanized displayName derivation from username at account creation
  - Username generation for OAuth-created users
  - `username` exposed on `GET /auth/me`
  - 12 new auth tests covering validation, reservation, callback, and OAuth paths

## v0.0.18 - 2026-07-11

### Added
- **Login-Link-First Auth UX:** Replaced the login/register toggle with a single email-first screen. Email login links are now the primary auth path, with password sign-in available as an inline fallback. New `POST /auth/send-login-link` and `GET /auth/login-link/callback` endpoints with Redis-backed one-time tokens, resend cooldown, and rate limiting. Google OAuth unchanged.
- **Agent Email Delivery UX:** Users can now control whether their agents email them
  - Account-level default in Settings (Agent Email Delivery card)
  - Per-agent tri-state override in create/edit form: inherit / allow / disable
  - Worker now resolves effective policy: agent override → user default → system default (enabled)
  - `messageClass` no longer gates email delivery; `emailDelivery: "if_allowed"` is the sole opt-in
  - `routine` messages can now trigger email when explicitly requested
  - Email delivery feedback in agent message list: sent / skipped-policy / not-configured / no-recipient / failed
  - `messageClass` badges in message list: alert (amber), reminder (blue), routine (silent)
  - New DB migration: `users.notificationPreferences` JSONB column
- LLM reasoning-mode controls: users can now set scout/judge reasoning levels (none/low/medium/high) in User Settings and per-agent\n  - Provider layer modernised to use unified reasoning parameter (OpenRouter/Anthropic standard)\n  - Model-aware mapping: effort-based for Fable 5/Sonnet 5/Opus 4.7+, token-budget for legacy Claude\n  - Reasoning level dropdowns in Settings, Agent Create/Edit, and Runtime Policy section\n  - Reasoning levels stored as runtime policy overrides with style-based defaults\n  - Operator-configurable ceilings (scoutReasoningMax, judgeReasoningMax)

## v0.0.17 - 2026-07-10

### Fixed

- **`get_account_summary` executionMode fallback:** When `agentConfigOps` is unavailable or returns no config, the tool now falls back to `ctx.executionMode` (always set by the agent runtime) instead of returning `"unknown"`. Agents will now always see their actual execution mode.

## v0.0.16 - 2026-07-09

- **Remove Mission Control — Consolidate into AI Agents Page:** Deleted the `/mission-control` dashboard page and moved its widgets (5 metric cards, setup card, activity feed, setup modals) into `/agents`, making it the single home for authenticated users. Added a public landing page placeholder at `/` for unauthenticated visitors. Backward-compat redirect from `/mission-control` → `/agents`. Removed Mission Control nav item from sidebar; AI Agents is now the default. Updated all redirect targets, i18n keys, E2E tests, and spec file names accordingly.

- Change `marketIntelligence.wakePolicy` from `batched` to `context` for `discovery_delta`
- **Macro-Economic Context Block:** Inject upcoming high-impact economic events (FOMC, NFP, CPI, etc.) into trading agents' context with zero tool calls. Dual-source (Forex Factory HTML + OHLC.dev JSON) with merge/dedupe, Redis-backed shared caching, and provider-driven context trimming. Disabled by default; enable via `marketData.economicCalendar.enabled`.

## v0.0.15 - 2026-07-09

### Fixed

- **Orchestration follow-up fixes (006-followup):** Removed duplicate termination listener from `AgentRuntimeLauncher` (already registered by `DockerRuntimeAdapter`). Added `NodeClass == "agent"` filter to `list_eligible_agent_nodes()` so the control-plane client node is never a scale-in candidate. Replaced last remaining `||` resource fallback with `??` in `nomad-runtime-adapter.ts` to preserve `0` as a valid value. Added test coverage for `buildAgentEnv` sharedServices URL construction path. Deprecated legacy `terraform.tfvars.example` in favor of per-environment templates.

### Added

- **Terraform workspaces (007-terraform-workspaces):** Multi-environment state isolation via Terraform workspaces. `provision.sh` and all deploy scripts (`deploy.sh`, `push.sh`, `setup-env.sh`, `logs.sh`, `seed-admin.sh`, `reset.sh`, `reset-and-run.sh`, `maintenance-restart-from-local.sh`) are now workspace-aware — `--env staging|production` automatically selects the correct Terraform workspace and resolves the matching server IP. SSH key auto-detection falls back to `${HEROBIDS_ENV}.tfvars` when `terraform.tfvars` is absent. Includes a one-time migration procedure for existing staging state, `.gitignore` for workspace state files, and updated README/smoke-test documentation.

- **Agent PnL Display (006-agent-pnl-display):** Aggregate and per-agent realized PnL across three surfaces: Mission Control homepage (Total Realized P&L metric card), Exposure page (aggregate PnL summary header), and Agent list (per-agent P&L, trade count, and win rate on each AgentSummaryCard). Backend adds `GET /agents/performance` bulk endpoint and `totalRealizedPnl` to `GET /dashboard/overview`. Frontend adds shared `formatPnl`/`pnlColor` helpers and full i18n support (en/ar/hi) with ICU plural syntax.

- **Wake-Driven Cost Reduction (005-wake-cost):** Three-layer wake policy to reduce unnecessary LLM invocations. Source-scoped cooldowns (Part A) prevent low-urgency discovery events from throttling urgent watch-threshold wakes. Mode-based delivery (Part B) adds `wake`, `batched`, and `context` delivery modes — `context` mode emits market events without triggering `agent.wake`, storing them as structured pending context that appears in the next tick prompt and prevents `context_unchanged` skips. Per-agent wake subscriptions (Part C) let agents filter which monitor-owned sources they receive via `wake_preferences` JSONB, exposed through API and UI with Redis-backed real-time routing.

- **Nomad agent orchestration (004-orchestration):** Agents now launch on a Nomad cluster instead of the worker's local Docker daemon, enabling multi-node horizontal scaling. Includes: Nomad runtime adapter (Phase 4), per-tier resource profiles with soft overcommit (Phase 5), autoscale-out via flock-guarded Terraform (Phase 6), nightly conservative scale-in and placement-failure safety net (Phase 7), admin email alerting for scaling failures (Phase 8), and staging/production runbooks with explicit rollback procedure (Phase 9). Control plane remains on Docker Compose; agent nodes are stateless, disposable Nomad clients on a private Hetzner Cloud network.

- **Staging environment:** Split the single-environment deploy model into separate staging and production environments with isolated infrastructure, secrets, domains, and runtime policy. Staging runs with `NODE_ENV=staging`, mock billing, and live trading disabled by default. Production runs with `NODE_ENV=production` and enforces non-mock billing. Includes separate compose overlays (`docker-compose.staging.yaml` / `docker-compose.prod.yaml`), Caddyfiles (`Caddyfile.staging` / `Caddyfile.prod`), env file conventions, Terraform variables, and staging config validation tests.

## v0.0.14 - 2026-07-08

### Fixed

- docs/bug-reports/2026/07/08/001-watch-digest-unknown-blocks-tick-gate.md

### Changed

- **Billing page simplification:** Replaced the four-field AI Usage stat grid with a visual `CreditGauge` component showing a progress bar, remaining credit, usage breakdown, and status badge. Detail sections (spend controls, usage filters, ledger, events, periods, breakdowns) are now collapsed behind a "View details" toggle, making the default view significantly shorter. No backend changes required.

## Added

- Option to search skills on the skills page
- Option to search skills when creating/editing agents

## v0.0.13 - 2026-07-08

### Fixed

- **Watch coverage auto-link:** `watch_token` now auto-derives `coverage.positionKey` when the agent creates a protective watch (`stop_loss`, `take_profit`, `exit`) without explicitly providing `coverage.targetPosition`. Resolves the agent's open position by venue + symbol and links the watch automatically. Prevents the escalation loop where `open_position_uncovered` forces the judge on every tick despite protective watches existing.

## v0.0.12 - 2026-07-08

### Removed

Removed links to the following from the sidebar: Trading Setup, Exposure, Activity, Outcomes

### Added

- **Billing Ledger read path:** New `GET /billing/ledger-entries` API endpoint, repository method, API client, and "Billing Ledger" card in the billing page. Shows every financial movement (credits, debits) in chronological order with direction filtering and pagination.

- **LLM Cost Reduction — Complete Tick Gate Fingerprint:** Expanded `shouldSkipTick` context-hash gate with watch summary, wake signal, and risk/playbook digests. Uses `__unknown__` sentinel for unavailable data. Zero additional I/O. Preserves all safety valves.
- **LLM Cost Reduction — Bot Config Preflight on Start:** Added `BotConfigSchema` validation before marking bots running in both agent broker and API start paths. Prevents invalid persisted config from entering start→fail→retry cycles.
- **LLM Cost Reduction — Atomic maxBots Budget Guard:** Transaction-based atomic enforcement with `SELECT ... FOR UPDATE` on agent row. Applied to create, start, and API-triggered lifecycle paths. Reclaim exempt. Config-driven defaults.
- **Session Circuit Breaker & Non-Wakeable Events:** New `SessionCircuitBreaker` state machine suppresses LLM invocations during unrecoverable error/drift loops. Tracks `strategy_error`, `strategy_fatal`, `drift_detected`, `stream_disconnect`. Configurable under `agentRuntime.sessionCircuitBreaker`. Estimated 40-60% token reduction for pathological sessions.
- **Bot create custom strategy config:** Added a "Custom" card to the bot strategy preset grid. Selecting "Custom" reveals `BotCustomConfigSection` with structured fields for strategy type, signal bias, candle parameters, exit targets, position sizing, and risk guardrails — no JSON editing required. Swap venues hide candle-based fields and show an informational notice. Pre-populates from the first loaded preset for a familiar baseline. Includes blur-triggered inline validation with NaN guards. Resets to defaults when switching away from custom mode.
- **Watch system redesign:** Consolidated watch types into single canonical module (`watch-types.ts`). Added structured purpose and coverage metadata to watches. Added canonical instrument identity resolution at watch creation. Extended wake payload schemas with purpose, instrument identity, and position keys. Implemented position coverage evaluation with 3-tier matching. Replaced blanket open-position escalation with coverage-aware gating. Added stale coverage detection and escalation. Tightened runtime summaries with purpose prefixes and coverage status blocks.

## v0.0.11 - 2026-07-07

### Added

- coinmarketcap env key egistry arity and documentation
- **Per-trade stop-loss and take-profit (complete):** Agents can now set `stopLoss` and `takeProfit` price levels on every `submit_decision` that opens or increases a position. Levels are validated against mark price at intake, stored in decisions metadata, and monitored via a 5-second periodic loop. Post-implementation gaps resolved: reminder messages now surface in the tool reply, `stopLossPct` removed from agent-visible surfaces, market feeds bootstrapped for paper-mode rehydrated positions on restart, exit-level rehydration lifecycle-bounded by `position.openedAt` to prevent stale levels from prior positions.
- **Venue symbol validation at decision intake:** Agents can no longer submit decisions for symbols that don't exist on their bound venue. An in-memory `VenueInstrumentCache` validates every incoming `instrumentId` against venue-provided symbol lists before the decision reaches the executor. Rejects unknown symbols with `instrument_unknown` code. Supports Hyperliquid, Bybit, and Jupiter venues with per-venue symbol normalization. 1inch is intentionally excluded (universal aggregator — any token is valid). Includes periodic 60-minute cache refresh and non-blocking `instruments` table population (orderbook venues only) for operator visibility.
- **Analytics filters parity:** Added `symbols` filter and `symbol` groupBy to analytics API. Filter by instrument to see which are profitable. `groupBy=symbol` aggregates P&L per symbol (skips journal events which lack symbol). Added `exitReasons` filter and `exitReason` groupBy — filter by closure reason (`signal_lost`, `parabolic_move`, etc.) to understand why positions close. Added `exitReason` column to `positions` table (migration `0034_elite_la_nuit`), stamped from decision `metadata.reason` on close.
- **Watch token discovery and pinning:** `watch_token` now accepts `chain: "any"` for cross-chain discovery. The system resolves the asset once at creation time and pins the watch to a concrete identity (chain + address). Future price checks use the pinned identity, preventing silent drift when market liquidity shifts between chains. Legacy watches are lazily repaired on first `check_watches` evaluation. `get_price` behavior remains unchanged for one-shot discovery.
- **Trading session presets:** Named market-window shortcuts (Asia, London, NY Morning/Mid/Afternoon) in the agent form's "Allowed active hours" control. Sessions are stored as semantic names and resolved to UTC with DST awareness via `Intl.DateTimeFormat('America/New_York')`. Only shown for trading agents.
- Glossary
- Agent evaluation: `unified-agent-config.json` downloadable artifact containing the agent's current persisted unified config at evaluation time
- **Agent stop cascades to bots:** When an agent is stopped, all running agent-created bots are cascade-stopped via `AgentHealthMonitor` (primary UI/API path), `onSessionStopped` callback (supplemental), and `DockerAgentManager.onAgentCrashed` (crash path). Periodic `botOrphanSweepInterval` reconciliation sweep catches missed orphans. Configurable via `worker.agents.botOrphanSweepIntervalMs`.
- E2E journey 17: bot creation modal interactions — page render, empty state, disabled submit without connection, cancel dismiss (UAT I-01, I-02, I-04)

### Changed

- **Eliminate static LLM pricing (ADR 001):** All provider model pricing (OpenAI, Anthropic, DeepSeek, Google) now cross-referenced from the OpenRouter `llm_pricing_snapshots` table instead of hardcoded YAML.
- **Restructure public content to `{lang}/{type}/` layout:** Content files moved from `content/{type}/{locale}/` (and flat `content/{type}/` for English-only) to the standard `content/{locale}/{type}/` layout. `loadContent()` simplified to a single unified path. All 14 markdown files now live under `content/en/`.
- **API key gating:** `GET /ai/available-models` now hides providers without a configured `LLM_API_KEY_<PROVIDER>` or generic `LLM_API_KEY` environment variable (ollama exempt).
- **Locality gating reverted:** Dev-only provider gating restored to `NODE_ENV`-based check. Removed hostname inspection (`isLocalProviderEndpoint`) and `llm.catalog.locality` config key.
- **Single-provider UI mode:** When only one LLM provider is available, the provider dropdown is auto-selected and hidden in the UI.
- **Relaxed provider schema:** `ProviderConfigSchema` now supports `pricingSource: 'openrouter' | 'inline' | 'none'` to control pricing origin.
- **Venue-aware bot symbol field:** The bot creation modal now adapts the symbol input label and placeholder based on the selected connection's venue type — "Instrument (e.g. WETH/USDC)" for swap venues (jupiter, 1inch) and "Symbol (e.g. BTC-PERP)" for orderbook venues (hyperliquid, bybit).

### Removed

- **Legacy `maxDrawdown` from agent-facing surface:** The absolute USD `maxDrawdown` field was removed from agent API schemas (create/update/interactivity), risk-defaults response, export config, client types, form state, UI components, locale strings, worker risk limit construction, and domain tool types. The canonical agent drawdown control is now exclusively `maxDrawdownPct` (percentage). The operator ceiling (`agentRiskDefaults.maxDrawdown`) is still used internally as a safety net for non-agent flows.
- `seedStaticPricing()` function and its worker startup call — static YAML prices are no longer seeded into the DB.
- **"Advanced: raw JSON config" toggle from bot creation:** The raw JSON editor escape hatch was removed from the bot create modal to simplify UX and align with agent creation. Strategy config is now exclusively preset-driven. Power users can use the API directly.

### Fixed

- Bot creation submit button now correctly disabled when the symbol field is empty, matching the backend `symbol: z.string().min(1)` requirement and preventing guaranteed 400 errors.

## v0.0.10 - 2026-07-06

### Fixed

- Fix llm billing, by using approximation where necessary.

## v0.0.9 - 2026-07-06

### Added
- Bot strategy error circuit breaker: consecutive `strategy.config_invalid` (1 failure) or `strategy.execution_error` (5 failures) auto-halts bot, emits `strategy.fatal`, notifies agent.
- `agentRiskDefaults.maxDrawdown` operator config field, split from `dailyLossLimit`.
- `agentRiskDefaults.botConfigInvalidHaltThreshold` and `botExecutionErrorHaltThreshold` config fields.
- `strategy.fatal` journal event type.
- `executionTimeoutMs` on `DecisionIntakeDeps` — executor calls now have a configurable timeout guard (default 30s).
- Redis equity cache (`equity:{actorId}` hash) — worker writes equity snapshot after each decision; `get_risk_limits` reads live drawdown from Redis.
- `get_risk_limits`: added `maxDrawdown` to limits response and `source` field to `dailyLoss` and `drawdown` runtime sections.
- DB migration `0032_opposite_photon.sql` — adds `max_drawdown` column to `agents` table.
- Optional prompt template for skills
- Optional prompt hint for skills

### Fixed
- Shadow/paper reconciliation: reconciler is no longer started for non-live execution modes, eliminating false-positive `reconciliation.drift_detected` events.
- `list_bots` data shape: broker path now emits `{ ok, bots: [] }` (matching the direct tool path), fixing empty "Managed Bots" in agent context.
- `DATABASE_URL` forwarding: logs a prominent warning when absent from worker env instead of silently skipping.
- Risk limit transparency: `maxDrawdown` is no longer silently aliased from `dailyLossLimit` — each has independent enforcement with separate config fields.
- Evaluator tool failure attribution: split by `actorType` — agent tool failures and bot strategy errors are now tracked independently.
- `submit_decision` sync reply: `accepted` is now emitted only after execution completes successfully, preventing false-positive acceptances when execution fails.

### Changed


- Move skills section from advanced section to main section of create/edit agent form

## v0.0.8 - 2026-07-05

### Fixed

- Billing: fix LLM usage pricing for cached input tokens and dated OpenRouter model IDs, including rate-card matching and cache-read pricing ingestion

## v0.0.7 - 2026-07-03

### Infra

- Worker: wire `DockerAgentManager.reconcile()` into a 60 s timer so orphaned agent containers are cleaned up automatically

- Docker: shared `build-shared` stage compiles 7 packages once for both `api` and `worker`, halving build time and peak memory on the Hetzner server; removed post-deploy `docker builder prune -af` that was destroying build cache after every deploy

### Fix

- Admin display of app version
- Admin display of container stats

## v0.0.6 - 2026-07-03

### Added

- **Prompt Context Enrichment** — Operator-configurable prompt enrichment system (`promptStyle: 'enriched'`) that injects additional context into agent LLM prompts:
  - Auto-injected agent memory in both tick and hybrid evaluator prompts (configurable inline key limit)
  - Judge response history displayed in hybrid evaluator prompts for decision continuity
  - Trading config reference block (execution mode, risk limits) in tick prompts
  - Queued wake signals surfaced between ticks
  - Wake trigger emphasis instruction appended to watch/discovery/regime change contexts
  - Chronological activity timeline interleaving user messages, memory writes, and judge decisions
  - All knobs configurable via `agentRuntime.promptEnrichment.*` in operator config; `promptStyle: 'classic'` bypasses all enrichments for side-by-side regression testing
  - Fixed hardcoded `slice(-10)` judge history limit → configurable `tickMaxDisplayed`

- **LLM Token Optimization** — Three targeted changes to reduce LLM input/output token waste:
  - **Compact number formatting** (`fmtNum`/`fmtUsd`): K/M/B/T suffixes replace verbose `toLocaleString()`/`toFixed()` for USD values ≥10K in agent prompts (~30–40% token reduction in market-data sections).
  - **Output `maxLength` constraints**: `rationaleSummary` capped at 400 chars (schema-level); LLM `reasoning` field truncated to 80 chars with prompt instruction.
  - **`stripEmptyValues()` utility**: Removes `null`/`undefined`/`""` keys from LLM output objects before Zod validation, preventing parse failures when LLMs emit empty optional fields.
- **Agent Bot Mode Escalation Guard** — Shared `checkModeEscalation` helper prevents agents from creating or adjusting bots to an execution mode that outranks the agent's own. Enforced in both the broker (`manage_bot` path) and the direct `adjust_bot_config` tool. Adds `executionMode` to `ToolContext`, stores sanitised tool-call arguments in `agent_messages` for retrospective audits, and notifies agents when a user patches their bot's config via the API. The evaluate-agent skill now includes execution-mode coherence checks and separates policy anomalies (HIGH) from operational anomalies.
- **Style-Based Strategy Presets** — YAML-driven presets with `percent_equity` sizing, backend loader + API (`?style=`), frontend style selector, and DB migration (0029). Economy/Standard/Premium tiers replace hardcoded STRATEGY_PRESETS.
- **Strategy Preset Agent API** — Agent create/update endpoints accept `strategyPreset` to resolve and persist style-based preset config (technical, execution, risk). Explicit user overrides take precedence over preset defaults.
- **Agent Response Metadata** — Agent GET responses now include `strategyPreset` provenance from `unifiedConfig.metadata` for round-trip editing.

### Changed

- **Agent Preset Contract** — `applyPresetToAgent()` now uses `fixedPositionSize` (matching `UnifiedAgentConfigSchema`) instead of `positionSize`. DCA presets are rejected for agent application.
- **DCA Runtime Parity** — DCA strategy supports `amountPerBuyMode: 'percent_equity'` with equity-aware sizing at runtime, matching preset YAML semantics.
- **Web Agent Form** — Backend-driven strategy preset selector is now the single preset surface. The legacy frontend-only `TECHNICAL_PRESETS` system (`technical-presets.ts`) has been removed; `TechnicalConfigSection` is now a pure raw-parameter editor for custom mode. Preset-managed agents round-trip correctly in edit (preset provenance is hydrated from `unifiedConfig.metadata`), the preset tier label reflects the agent's actual style, manual edits flip the form to `custom`, and `PATCH strategyPreset: null` cleanly strips preset-managed `metadata`/`execution` while preserving technical config.

## v0.0.5 - 2026-07-01

### Added

- Improved ux for connecting agents to external platforms

## v0.0.4 - 2026-06-31

### Fixed

- Bug which mis handles min hold duration

## v0.0.3 - 2026-06-31

### Changed

- Improved UX

## v0.0.2 - 2026-06-30

### Added
- **Agent Evaluation (Level 2 — Frontend)** — User-facing UI for evaluation history and triggers
  - Added evaluation API methods to `apps/web/src/lib/api-client.ts` (`list`, `get`, `trigger`, `listArtifacts`, `getArtifactUrl`)
  - Created `AgentEvaluations` component with collapsible `<details>` section, run list with status/scores, inline scorecard, findings table, and artifact downloads
  - Created `AgentEvaluationReport` component for inline Markdown report rendering using `react-markdown`
  - Integrated `AgentEvaluations` section into `AgentDetailPage` (after Activity Timeline)
  - Added i18n keys under `agents.evaluations.*` namespace
  - Added `@herobids/domain` as a workspace dependency of `@herobids/web`
- **Agent Evaluation (Level 1)** — Full implementation across 10 phases
  - Phase 0: Extracted reusable data loaders (`loadAgentFills`, `loadAgentJournalEvents`, `loadAgentRuntimeSessions`, `loadAgentPositions`, `loadAgentBotIds`) from `apps/api/src/routes/exports.ts` into `packages/db/src/agent-evidence-loaders.ts`
  - Phase 1: Defined core evaluation contracts in `packages/domain/src/agent-evaluation.ts` (`EvaluationScope`, `EvaluationRunRecord`, `EvaluationScorecard`, `EvaluationArtifactStore`, etc.)
  - Phase 2: Created `agent_evaluations` table (migration 0024), repository (`resolveScope`, `createRun`, `markRunning`, `markSucceeded`, `markFailed`, `markTimedOut`), and shared job contract (`EvaluationJobData`)
  - Phase 3: Built `EvaluationRuntime` class (BullMQ Worker pattern) with no-op handler, wired into worker startup/shutdown
  - Phase 4: Implemented `FsEvaluationArtifactStore` in `packages/db/` (shared by API + worker)
  - Phase 5: Evidence assembler — orchestrates shared loaders and writes artifacts to store
  - Phase 6: Deterministic analyzers — core (session health, tool failures, cost, persistence), trading (drawdown, expectancy, hold time, rate limits), security (secret leakage, thinking traces)
  - Phase 7: Report renderer (pure Markdown from scorecard), redaction layer, `runEvaluation()` orchestrator
  - Phase 8: API routes — `POST /agents/:id/evaluations` (trigger), `GET` (list/status/artifacts/download), scope-aware dedupe (409), `allTime` opt-in gating
  - Phase 9: Structured pino logging throughout pipeline, dead-run reaper (periodic 60s sweep for stale `running` evaluations)
- Configuration: `evaluation` section in `config/default.yaml` with `concurrency`, `maxRuntimeMs`, and `thresholds`
- **Narrative LLM Selection** — Full implementation across 5 phases
  - Phase 1: Extracted `resolveEffectiveLlmSelection` and `resolveAgentCostProfile` from worker into `packages/domain/src/` (shared by API + worker)
  - Phase 2: Extended evaluation request and job contracts with `NarrativeLlmRequest` (caller-facing) and `ResolvedNarrativeLlmConfig` (worker-facing) types
  - Phase 3: Narrative LLM resolution at enqueue time in API — resolves provider/model via agent modelPolicy + user AI defaults + cost profile, validates against providersYaml, derives baseUrl
  - Phase 4: Worker narrative generator (`generateEvaluationNarrative`) — LLM-powered commentary using scorecard + top findings, best-effort with temperature=0 and toolChoice='none'
  - Phase 5: Billing (granular input/output token events with idempotency keys) and provenance metadata (`narrative-metadata.json` artifact)
- **Strategy Presets Expansion & Mechanical Parity** — Full implementation across 6 phases
  - Phase 0: Expanded `MechanicalParamsSchema` with VWAP, Price Action, Sentiment configs, exit targets (`stopLossPct`, `takeProfitPct`, `trailingStopPct`), and `minCandleCount`
  - Phase 1: VWAP and price-action scoring in `scoreCandidate()` with 6 unit tests
  - Phase 2: Removed momentum-to-mechanical translation bridge, simplified both `createStrategy()` factories
  - Phase 3: 7 strategy presets in web UI (momentum-day, momentum-position, swing, range, contrarian, scalper, dca) with mechanical-format params
  - Phase 4: Blueprint presets aligned with mechanical-format params (7 presets including momentum-position)
  - Phase 5: `DcaStrategy` implemented (timer-driven buys with `intervalMs`/`amountPerBuy`)
  - Phase 6: Sentiment threshold gating with hard-veto and boost logic in `MechanicalStrategy`
- `VwapParamsSchema`, `PriceActionParamsSchema`, `SentimentConfigSchema` in domain config
- `DcaStrategy` class with `DcaParamsSchema` in strategy package
- **Per-agent runtime policy controls**: Agent style presets (Careful/Balanced/Bold) with configurable defaults for tool turns, LLM token limits, context budgets, trading hours, and scout hold duration. Overridable per-agent via `runtime_policy_overrides` JSONB column. Resolved policy flows from API → session manager → agent container. Operator ceilings enforced via Zod validation. Frontend style picker shows derived summary (turns × tokens × daily budget). E2E test script at `scripts/shell/tests/runtime-policy-e2e.sh`. Integration tests in `packages/domain/src/config/runtime-policy-propagation.integration.test.ts`. Full i18n coverage (en/ar/hi). Config `default.yaml` updated with per-agent model documentation.

- Birdeye market data provider: opt-in Solana-only provider for token discovery (trending), token overview, and OHLCV candles. Config-driven via `config.birdeye.*`; disabled by default; enabled-without-API-key fails fast at startup. HTTP 400 responses are treated as warn-and-skip (rate limits / unsupported tokens). Runtime failures are isolated via `Promise.allSettled` and do not block other providers.

- Bot lifecycle API endpoints: `DELETE /bots/:id`, `POST /bots/:id/stop`, `POST /bots/:id/start`

- **Tool autocomplete in skill editor (008-tool-autocomplete-skill-ui)**: `TOOL_CATALOG` in domain with all 46 agent tools mapped to categories and descriptions. `GET /api/v1/agent-tools` discovery endpoint with optional `?category=` filter and category summary. `ToolTagPicker` combobox component in shared UI kit — category-grouped multi-select with search filtering, keyboard navigation (arrow keys + Enter), removable pills, sorted output, and i18n-ready label props. Integrated into skill create composer and SkillCard inline edit form. `requiredTools` now surfaced in the UI for the first time.

- Birdeye market data provider: opt-in Solana-only provider for token discovery (trending), token overview, and OHLCV candles. Config-driven via `config.birdeye.*`; disabled by default; enabled-without-API-key fails fast at startup. HTTP 400 responses are treated as warn-and-skip (rate limits / unsupported tokens). Runtime failures are isolated via `Promise.allSettled` and do not block other providers.

- **Broker-side billing notifications**: Telegram and email notification dispatch when agents hit soft-cap (`billing.soft_limit_reached`) or hard-cap (`billing.limit_exceeded`) spending limits. Redis-based deduplication (24h TTL) prevents notification spam — users are notified once per status transition. HTML-escaped message templates include open position context for hard caps. Graceful degradation when Telegram/email/Redis are unavailable.

### Changed

- **Generalize credentials & agent connection assignment (Phase 1.7)** — Provider-driven venue type and credential field derivation
  - Added `venueType` field to `ProviderDefinition` domain type, derived from provider categories in the catalog
  - `GET /providers/catalog` now returns `venueType` ('orderbook' | 'swap' | null) for each provider
  - `AgentsPage` and `EditAgentModal` now derive venue type from the provider catalog API instead of the hardcoded `VENUE_TYPE_MAP`
  - Added `buildVenueTypeMap()` utility in `venue-mapping.ts` to construct a venue-type lookup from catalog data
  - Deprecated hardcoded `VENUE_TYPE_MAP` and `PROVIDER_TEMPLATES` in favor of API-driven data
- **Move Venue to Trading Setup (Phase 1 — Frontend)** — Venue is now derived from trading connections instead of stored in technical config
  - EditAgentModal derives venue/venueType from agent's active trading connection at save time
  - Paper mode venue dropdown shows whenever no connection is selected (not just when no connections exist)
  - Extracted `VENUE_TYPE_MAP` to shared `venue-mapping.ts` module
  - Removed unused `agents.technical.filters.venue.required` i18n key from all locales
- **Merge connections + trading_bindings** — Simplified credential→connection→agent access model
  - Merged `trading_bindings` table into `connections` (absorbed `provider_ref`, `profile` columns)
  - Dropped `agent_credentials` table — agents access credentials exclusively through `capability_grants → connections → user_credentials`
  - Renamed `user_credentials.venue` → `provider` for consistency
  - Renamed `capability_grants.binding_id` → `connection_id` with FK to `connections`
  - Renamed `bots.trading_binding_id` → `connection_id` with FK to `connections`
  - Updated all API routes, worker resolvers, runtime descriptors, domain types, web frontend, scripts, tests, and documentation
  - Simplified user flow: "Create credential → Create connection → Select connection" (no more binding step)
  - Migration: `drizzle/0026_clear_charles_xavier.sql`
- **Exact Connection Routing & Atomic Agent Assignment** — Production-hardened connection-based trading routing
  - Added `providers` table with capability definitions, `agent_connections` table for atomic agent→connection grants
  - Added `resolvedVenueAccountId` FK to `connections` — trading-ready connections carry an explicit venue account
  - Rewired bot creation (API + agent broker) to resolve venue accounts from the selected connection row only
  - Removed provider-based `(userId, provider)` venue account inference — all routing is exact by `connectionId`
  - `POST /agents` accepts `connectionIds` and creates agent + connection assignments in one transaction
  - `PATCH /agents/:id` declaratively syncs `agent_connections` rows (insert missing, revoke removed)
  - Worker startup validates `bot.connectionId` ↔ `connection.resolvedVenueAccountId` consistency; refuses startup on mismatch
  - Readiness and runtime capability descriptors derive capability families from `providers.capabilities` via `agent_connections`
  - Replaced `capability_grants` vocabulary in AGENTS.md with `agent_connections`
  - Cleaned up transition comments, dead `tradingBinding` test assertions, and unused imports from migration phases
- **Delete legacy capability_grants tables** — Safe removal after full migration to agent_connections
  - Migrated capability readiness routes from `capability_grants` to `agent_connections` + `providers.capabilities` joins
  - Deleted `grant-service.ts` and legacy bind/unbind action endpoints (replaced by declarative `PATCH /agents/:id`)
  - Moved connection revoke logic from `capability_grants` to `agent_connections` lookup
  - Fixed UI contract drift: `connectionStatus` → `status` on generic `/capabilities/trading/connections` endpoint
  - Replaced `CapabilityGrant` domain contract with `AgentConnection`; removed old schema exports
  - Dropped `capability_grant_audit` and `capability_grants` tables (migration `0028_burly_fallen_one` — IRREVERSIBLE)
  - Worker sandbox tool-policy `CapabilityGrant` type intentionally preserved (unrelated concept)
- `apps/api/src/routes/exports.ts`: agent routes refactored to use shared data loaders (reduced duplication)
- `candleLimit` default: 100 → 48
- `MechanicalParamsSchema`: `stopLossPct` and `takeProfitPct` now required (no defaults)
- `MechanicalStrategy`: uses `params.minCandleCount` (was hardcoded 20)
- Agent export endpoints (`/agents/:id/export/*`) now include agent-native fills, positions, and journal events alongside bot-owned records; added `actorType` discriminator to agent-native and bot journal queries in export bundle for actor-scope correctness.

- **Dynamic LLM Pricing**: Provider pricing sourced from PostgreSQL (`llm_pricing_snapshots`) + `config/providers.yaml`. Hardcoded `PROVIDER_DEFINITIONS` removed. OpenRouter pricing fetched hourly by worker, static providers seeded on startup. API model catalog reads from DB. Rate card seeding uses DB snapshots instead of build-time constants.

- Bot lifecycle API endpoints: `DELETE /bots/:id`, `POST /bots/:id/stop`, `POST /bots/:id/start`
- Bot lifecycle UI controls: Stop/Start/Delete action buttons on bot detail page with confirmation modals
- E2E bot trade test script (`scripts/ts/bot-trade-test.ts`) and shell wrapper
- DB timestamp invariant unit tests (6 tests)
- API endpoint functional tests for bot lifecycle
- UI interaction tests for bot detail page (11 tests)
- DexScreener boost enrichment pipeline: `fetchDexScreenerTokensByAddress` and `enrichDexScreenerBoostTokens` now enrich zero-liquidity boost/profile tokens with real on-chain pair data before the discovery threshold filter, turning three wasted DexScreener API calls into a useful discovery vector.

- Security auditor agent

- Documented the billing enforcement policy: soft cap warns without changing agent behavior, hard cap stops with explicit open-position notification, and added a public billing limits page, internal technical contract, and ADR-009 to freeze the decision.

### Fixed

- `markBotRunning` now clears `stoppedAt` to prevent inverted lifecycle timestamps on bot restart
- Worker `onStopped` callback now persists `status='stopped'` and `stoppedAt` to the database
- Bug which allowed agents excalate/increase bot execution mode e.g paper agent cannot create bot with exection mode shadow.
- `pnpm install` failure (`ERR_PNPM_NO_MATCHING_VERSION_INSIDE_WORKSPACE`) caused by prerelease version strings in workspace packages — changed all to plain `0.0.1`.

### Removed

- update_own_config tool
- Cost preset from frontend
- `momentum-to-mechanical.ts` and `.test.ts` — translation bridge deleted
- `translateMomentumToMechanicalParams` export from strategy package
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.0.1-2026.06.26-b

### Added

- UX improvement - agent capability filter (intelligence/hybrid) for trading agents

## 0.0.1-2026.06.26-a

### Added

- **Unified agent form (004-unified-agent-form)**: extracted shared `AgentFormBody` component and `AgentFormState` type consumed by both create and edit flows. Field changes happen once; both screens get them. Differences injected as `ReactNode` slots (modelSlot, skillsSlot, tradingBindingSlot, tradingSetupSlot, capabilityWarning, nameAutoHint) — no mode flags in the body. Includes `agentToFormState()` converter with runtime-validated union literal fields and `intentToFormState()` for the create shell. Added UAT cases AG-E01 through AG-E10 for the unified edit form.

- **Per-agent open position escalation to judge policy**: new `openPositionEscalationToJudgePolicy` field configurable per agent (never/uncovered_or_triggered/always). Persona mapping: careful→never, balanced→uncovered_or_triggered, bold→always. Replaces hard-coded blanket escalation in scout-gating with policy-based behavior. Frontend dropdown in create/edit advanced controls with i18n support (en/ar/hi).

## 0.0.1-2026.06.25-a

### Added

- Improve agent creation UX
- Improve bot management UX
- **LLM token optimization**: three-part optimization to reduce LLM costs and prevent context overflow:
  - **`maxHistoryTokens`**: dual-limit history trimming — token-budget (primary, ~4 chars/token heuristic) replaces message-count-only approach, with message-count as secondary hard ceiling
  - **Stale tool result truncation**: retroactively truncates older tool results in structured tool loops after a configurable retention window (`toolResultFullRetentionTurns`), capped at `toolResultMaxStaleChars` with `...[truncated]` marker
  - **Prompt caching**: top-level `cache_control: { type: 'ephemeral' }` on both OpenRouter and Anthropic native requests; cache-hit detection from `prompt_tokens_details.cached_tokens` (OpenRouter) and `cache_read_input_tokens` (Anthropic)

## 0.0.1-2026.06.24-a

### Added

- **Crash telemetry**: agent runtime now writes crash records to `/workspace/crash.log` on `uncaughtException`/`unhandledRejection` with best-effort Redis publish. Includes heap usage, error stack, and agent/session IDs for post-mortem analysis.
- **Runtime block visibility in `get_risk_limits`**: the tool now returns a `runtime` object showing current state against limits — open position count/blocked, daily P&L vs loss limit, and drawdown placeholder. Eliminates the broken "call get_risk_limits → submit → rejected → call get_analytics" pattern.
- **Simplified agent creation flow**: 30+ field form reduced to essential fields (Goal, Skill Preset, Style, Capital, Telegram, Name) with collapsible Advanced Settings. Style selector (Careful/Balanced/Bold) maps to cost preset + risk tolerance + tick interval simultaneously. Agent name auto-generated from style. Inline validation on review with field-specific error messages and scroll-to-error. Capital auto-fills daily loss limit to 5%.
- **Style selector component** (`StyleSelector.tsx`): radio group with Careful/Balanced/Bold options, each with descriptions. Maps to cost preset, tick interval, daily budget, and risk tolerance via `STYLE_CONFIG`.
- **Advanced settings accordion** (`AdvancedSettingsSection.tsx`): slot-based accordion with 4 independently collapsible subsections (AI Configuration, Skills, Trading Setup, Strategy).
- **Form validation** (`form-validation.ts`): validates all fields on Review click and on-blur for numeric constraint fields. Returns field-specific error messages.
- **Style persistence**: agent `style` field (`careful`/`balanced`/`bold`) now persisted through DB schema + API + frontend. Displayed in review step with i18n labels.
- **Config-driven loss-limit ratio**: `dailyLossLimitDefaultRatio` (0.05) now sourced from `config/default.yaml → agentRiskDefaults` instead of hardcoded. Exposed via `/agents/risk-defaults` API.
- **Config-driven cost estimates**: `agentCostEstimates` section in `config/default.yaml` with realistic per-tick LLM cost values (minimal: $0.12, standard: $0.21, premium: $0.31). Exposed via API.
- **Unit tests for agent creation**: 62 new tests across 5 test files covering style mapping, agent naming, form validation, capability mode derivation, and cadence constants.

### Fixed

- **Orphaned container lifecycle**: `AgentRuntimeLauncher.stop()` and `kill()` now fall back to DB lookup → Docker stop when the in-memory handle is missing (e.g. worker restart). Health monitor calls `stop()` instead of removed `removeHandle()`. Prevents stale tick storms from containers surviving session teardown.
- **Reconciliation loop silence**: `Reconciler.runPass()` now logs warnings on null venue state, tracks consecutive null passes with a staleness counter, fires an error alert after 10 consecutive null passes (~5 min), and exposes `ReconcilerHealth` via `getHealth()` for heartbeat integration.

### Changed

- **Agent creation form restructured**: Capability mode now auto-derived from skill selection + goal. Max bots derived from user plan (not user-editable). Shadow execution mode restricted to admin users. Tick intervals aligned across frontend/cost-profile to 60/30/15 min.
- **Tick intervals updated**: preset cadences changed from 30/15/5 min to 60/30/15 min in both `agent-cadence.ts` and `cost-profile.ts` to match new Style mapping.
- **Capital field moved**: capital is now a standalone field in the main form; removed from `TradingGuardrailsFields` and `AgentControlsSection`.
- **Cost-per-tick estimates updated**: frontend `agent-cadence.ts` and worker `cost-profile.ts` now use realistic LLM pricing ($0.12/$0.21/$0.31) instead of unrealistically low heuristics ($0.002–$0.05). Threshold boundaries adjusted to ≥60min/≥30min/<30min tiers.
- **Validation constraints deduplicated**: inline `ValidationConstraints` object in Review button replaced with shared `validationConstraints` variable. `maxPositionSizePct` now enforces platform ceiling.
- **Dead i18n key removed**: `agents.controls.maxBots` (without `.planDerived`) removed from all 3 locale files.
- **`deriveCapabilityMode` extracted** to standalone pure function from `AgentsPage.tsx` for testability.

- **Hybrid agent mode**: agents with both `technical` + `intelligence` config use a single-shot LLM evaluator — scanner gates LLM dispatch, no polling loop.
- **Scanner wake emission**: `AgentTradingActor` emits `agent.wake` with `source: 'scanner'` after technical scan finds entry signals or exit advisories.
- **Advisory mode**: when `hasIntelligenceConfig` is true, the scanner generates signals but does not submit decisions directly — exits respect `autonomousExit` config.
- **Hybrid agent prompt & evaluator**: `hybrid-agent-prompt.ts` builds a constrained prompt from scan signals + portfolio state; `hybrid-agent-evaluator.ts` calls LLM, parses JSON response, submits decisions.

### Changed

- **Wake infrastructure renamed**: `agent.market.wake` → `agent.wake`, `AgentMarketWakePayloadSchema` → `AgentWakePayloadSchema`, `emitAgentMarketWake()` → `emitAgentWake()`. Wake source enum extended with `'scanner'`.
- **Scanner wake schema**: `ScannerWakeContextSchema` added with `signalCount` (min 0 for exit-only wakes), `topSymbol`, `topConfidence`, `regimePass`.
- **Hybrid no-wake guard**: timer ticks on hybrid agents skip LLM dispatch when no wake signal is pending — housekeeping (heartbeats, message ingestion) still runs.

## 0.0.1-2026.06.22-a

### Added

- **Agent tool schema discovery** (`get_schema`): agents can now fetch JSON Schema Draft 7 definitions for config parameters and tool sub-schemas at runtime. A domain-level registry (`packages/domain/src/tool-schemas.ts`) provides versioned schemas with examples for `update_own_config.*`, `create_bot.config.*`, and `adjust_bot_config.config.*`. Call `get_schema("all")` to list available schemas, then `get_schema("<name>")` to fetch a specific one.
- **Instrument lookup tool** (`find_instrument`): resolves trading symbols to instrument IDs across venues. Accepts an optional `venue` filter (e.g. `"jupiter"` for Solana tokens, `"hyperliquid"` for perpetuals). Backed by a new `InstrumentRepository` with LIKE-based search across symbol, base, and ID columns.
- **Account summary tool** (`get_account_summary`): provides agents with usable capital, open positions (split by agent-direct vs bot-managed), risk limits (`maxOpenPositions`, `maxPositionSizePct`, `stopLossPct`), execution mode, position sizing config, and capital-aware guidance. Reports `warnings` when sub-dependencies (risk contract, agent config, capital lookup) are unavailable — agents can detect degraded data.
- **Entity resolver tools** (`resolve_bot`, `resolve_watch`, `resolve_task`): resolve entities by name/symbol/title instead of requiring UUIDs. `resolve_bot` matches case-insensitively against bot config symbols and IDs — returns a single match directly or multiple candidates for disambiguation.
- **File metadata tool** (`stat_file`): returns `exists`, `isDir`, `isFile`, `size`, `modifiedAt`, and `createdAt` for workspace paths. Use before `read_file` or `delete_file` to avoid errors on missing files. Non-existent paths return `null` for inapplicable properties (`isDir`, `isFile`, `size`).
- **Dry-run modes**: `create_bot` and `submit_decision` now accept `dryRun: true` to validate payloads via Zod schema without executing. The response includes a preview of what would be sent and a note clarifying what validation level ran (schema only — engine validation happens at publish time).
- **API discovery endpoints**: `GET /api/v1/tool-schemas` (schema registry), `GET /api/v1/strategy-schemas` (per-strategy param schemas with safe default presets), and `GET /api/v1/venue-defaults` (venue-specific slippage, fees, and order type recommendations) for external consumers.

### Changed

- **Validation error enrichment**: tool parameter validation failures now include `missingFields`, `invalidFields`, and the full `parameterSchema` in the error response, enabling agents to self-correct malformed payloads without an extra `get_schema` call.
- **`promptGuidance` for new tools**: `create_bot`, `submit_decision`, `get_account_summary`, and `stat_file` now include LLM-facing prompt guidance describing when and how to use each tool.
- **Dry-run note accuracy**: `create_bot` and `submit_decision` dry-run responses now accurately describe the validation level (Zod schema only, not full engine validation).
- **Venue defaults caveat**: the `venue-defaults` endpoint now documents that `feeBps` values are indicative — actual fees vary by volume tier and market conditions.
- **Instrument repository performance note**: documented that the current LIKE `%term%` pattern may cause full table scans on large instrument tables, with a suggestion for a `pg_trgm` GIN index if needed.

### Fixed

- **`get_account_summary` error visibility**: previously-silent sub-dependency failures (risk contract, agent config, capital lookup) now surface as `warnings` in the response — agents can detect when partial data is returned.

## 0.0.1-2026.06.21-d

### Fixed

- **Agent image not rebuilt on deploy**: `reset.sh` now builds `herobids-agent:latest` from `docker/Dockerfile.agent` after every `git pull`, before `docker compose up`. Previously the agent runtime image was stale across deployments, causing all agents to run old code regardless of the version deployed to the compose services.

## 0.0.1-2026.06.21-c

### Fixed

- Bug docs/bug-reports/2026/06/21/002-reset-sh-stale-version-no-git-pull.md

## 0.0.1-2026.06.21-b

### Fixed

- **Tool schema Draft 7 compatibility**: `convertZodToJsonSchema` now normalises Draft 4 boolean `exclusiveMinimum`/`exclusiveMaximum` to Draft 7 numeric form. Fixes DeepSeek (and other strict providers) returning a 400 on any tool whose Zod schema uses `.positive()` / `.negative()` (affected `list_bots`, `get_analytics`, `check_regime`, `search_tokens`, and others).

## 0.0.1-2026.06.21-a

### Changed

- **Agent runtime rate**: default `agent.runtime_ms` rate set to $0.0001 per minute; all default rate card items are now configurable via `usageBilling.defaultRateCardItems` in operator config.
- **LLM model pricing**: static provider definitions (OpenAI, Anthropic, DeepSeek) now include per-model `pricing` (`inputUsdPerM`, `outputUsdPerM`, `reasoningUsdPerM`). The rate card is seeded with per-model items automatically; `computeCharge` prefers the model-specific rate over the catch-all fallback. New domain helpers: `getLlmModelPricing()`, `getLlmModelRateCardItems()`.

## 0.0.1-2026.06.20-a

### Added

- `extractStrategyFromConfig()` domain helper — type-safe strategy extraction from bot configs
- `decisionMode` and `executionModes` filters on analytics endpoints with Zod enum validation
- Agent tool schemas for `create_bot` and `adjust_bot_config` (`BotConfigInputSchema`, `StrategyInputSchema`)
- `IntelligenceConfigSchema` in `UnifiedAgentConfigSchema` — agents can now update their own intelligence config
- `translateMomentumToMechanicalParams()` — bridges old momentum-style params to the new mechanical engine
- Short signal support in scan engine — dual bullish/bearish confidence tracking produces `go_short` intents

### Changed

- **Strategy schema**: `StrategyConfigSchema` replaced with `StrategySchema` — `type` (trading style) and `decisionMode` (engine: mechanical/llm/hybrid) are now separate fields
- Blueprint `strategyPreset` column dropped (migration `0019_chubby_sway`) — derived at read time via `extractStrategyFromConfig()`
- Bot config `venue`/`venueType` are now optional at parse time — stamped by the broker at creation
- `deriveStrategyPreset` JSDoc documents intentional pass-through for unmapped types
- `agent-message-broker` resolves venue account and venue type from trading binding before creating bots
- **Momentum → Mechanical migration**: `MomentumStrategy`, `MomentumParamsSchema`, and `requireMomentumForMechanical` removed. Momentum bots now route through `MechanicalStrategy` via param translation. Mechanical strategy passes through signal intent (`go_long`/`go_short`) instead of always `go_long`.
- **Venue account resolution**: `venueAccountId` removed from bot start/restart config payloads in `agent-message-broker` — resolved exclusively via `startupContext.sourceVenueAccountId` at job processing time.
- **Startup venue-account check**: conditional on `sourceVenueAccountRequired` (per provider type) instead of unconditional. Switched from generic `Error` to `BotStartupError` with error code `missing_source_venue_account`. Added type-safe narrowing for downstream consumers.

### Fixed

- Blueprint config extraction uses `extractStrategyFromConfig()` instead of inline `as Record<string, unknown>` casts
- `AnalyticsQuery` type now correctly derived from `AnalyticsQuerySchema` (was `AnalyticsBodySchema`)
- `translateMomentumToMechanicalParams` clamps `candleLimit` to schema minimum (20) — prevents `strategy.config_invalid` errors for bots with small `lookbackPeriod` values

## 0.0.1-2026.06.19-g

### Added

- Deepseek models

### Fixed

- LLM provider catalog metadata: preserve `isMultiProvider` on non-OpenRouter catalog responses and clarify that one-line registry additions apply to static providers only.

## 0.0.1-2026.06.19-f
## 0.0.1-2026.06.19-e
## 0.0.1-2026.06.19-d
## 0.0.1-2026.06.19-c
## 0.0.1-2026.06.19-b

### Fixed

- Bug [2026/06/19/002 | workspace resolution](docs/bug-reports/2026/06/19/002-dockerfile-agent-deploy-workspace-resolution-failure.md)

## 0.0.1-2026.06.19-a

### Added

- Discovery diversity (2026-06-18): removes the hardcoded 20-token ceiling from `discoverTokens`. `marketData.discovery.maxResults` (default 50) now controls the limit; agents may request 1–100 per call. GeckoTerminal page-2 support added (opt-in via `geckoTerminalExtraPages: 1`, off by default) expands the raw candidate pool by ~35 tokens per run. Anti-staleness Redis tracking (`antistalenessCooldownHours: 4`, `antistalenessTokenTtlHours: 24`) reorders fresh tokens to the top of each discovery run, preventing the same narrow set from dominating every tick. Redis failure is fail-soft: discovery completes normally with the standard sorted list. See `docs/features/2026/06/18/001-discovery-diversity/`.

- Hetzner production deployment infrastructure (2026-06-17): Caddy reverse proxy with Let's Encrypt TLS, production Docker Compose overlay, Terraform configs for Hetzner Cloud (CPX22, fsn1, Ubuntu 24.04), cloud-init first-boot provisioning (Docker CE, UFW, fail2ban, git clone, backups, systemd), and deploy scripts (provision, push, setup-env, seed-admin, logs, deploy orchestrator). See `infra/hetzner/`.

- Rich Strategy Parity — mechanical and hybrid strategies (2026-06-16): bots can now be configured with `strategy.type: 'mechanical'` (deep technical analysis via RSI, MACD, volume, CHOCH, S/R, regime with no LLM) or `'hybrid'` (mechanical pre-check gating an LLM final-judgment call). Added `CandleFetcher` port and `VenueCandleFetcher` adapter routing Hyperliquid→Binance and Jupiter→GeckoTerminal. Added `SentimentProvider` port (no concrete adapter yet). Extracted named indicator sub-schemas (`RsiParamsSchema` etc.) from `IndicatorConfigSchema`. Consolidated `PriceCandle` to domain.

- Unified Agent Create/Edit UI (2026-06-16): agent creation and editing now supports capability selection (Intelligence / Technical / Both). Technical-only agents use rule-based indicator scanning with no LLM cost. New `TechnicalConfigSection` with preset strategies (Momentum Breakout, Mean Reversion, Conservative, Custom), discovery filters, scan settings, indicator toggles, and confidence weights. Sidebar now has a persistent "New AI Agent" action below the AI Agents nav item. Full API support for `technical` config in create/update/read endpoints.

- Venue validation shell wrappers (2026-06-15): `scripts/shell/tests/validate-jupiter.sh` and `validate-1inch.sh` source credentials from `.env.venue-validation` and run canonical dry-run or live validation with `--execute`.

- Telegram slash commands (2026-06-15): Telegram users can now route `/to` commands to one or more named agents, broadcast to all routable agents, and fall back to automatic delivery when exactly one agent is available.

### Fixed

- 1inch quote response parsing (2026-06-15): The `/quote` endpoint returns `{ dstAmount }`, not `{ srcToken, dstToken, toAmount }`. Adapter now handles both shapes and makes token fields optional.

- Jupiter API URL migration (2026-06-15): Migrated from defunct `quote-api.jup.ag/v6` to `api.jup.ag/swap/v1` across adapter, tests, and config.

- Telegram reply threading (2026-06-15): agent Telegram messages now use reply anchors, new sessions send a first-boot Telegram anchor message, the public webhook routes replies back to the owning agent stream, and user-facing Telegram reply-threading documentation is now published.

- Agent risk configuration UI (2026-06-15): added agent-level open-position, position-size, stop-loss, and stop-loss-cooldown controls across the agent API, worker risk-limit resolution, web create/edit forms, and the agents risk-defaults endpoint.

- Payment provider selection and usage dashboard (2026-06-15): the billing page now always shows provider attribution and usage dashboard empty states even before a usage account exists, with focused render coverage for the no-account path.

- Agent usage billing (2026-06-13): added usage metering, spend caps, included credits, top-up credits, and worker-side billing enforcement for LLM and runtime usage.

- Commercial usage ledger (2026-06-13): added billing usage summary, event, breakdown, and period views on the existing billing surface, separate from trading fill history.

- DB-driven admin access (2026-06-12): `users.is_admin` now controls admin access, with promote/demote endpoints and plan-limit bypass for admins.

- Programming skill parity (2026-06-12): `execute_code` now supports JavaScript and Python with `npm`/`pip` dependency installation; added a separate `file-management` skill for workspace file manipulation (`read_file`, `write_file`, `list_files`, `delete_file`); agents can persist files across ticks within the same runtime.

- Preset naming alignment (2026-06-12): the assistant skill preset is now canonically `personal-assistant` everywhere — `SKILL_PRESET_MAP` in domain, frontend type and option value, API test fixtures, and the domain language glossary. The old `reminder` preset key is removed.

- Non-trading agent tick guard (2026-06-12): `hasTradingCapability` flag derived from resolved skill `capabilityFamilies` now gates all trading-specific tick work — regime evaluation, venue intelligence refresh, performance inputs, and their Binance/Hyperliquid/DexScreener calls — so agents with no trading skills never attempt market-data fetches and cannot be killed by provider timeouts.

- Tick error handling (2026-06-12): `shouldSkipTick` no longer throws for non-critical helper failures — `fetchVolatilityCandles` and `evaluateRegime` errors fall back gracefully and surface `degraded`/`degradationReason` on `TickSkipDecision`. Added `tick-gate` as a first-class `RuntimeFailureSource` (classified as `degraded`, `tick_gate.degraded`). `FailureBackoffController` now tracks per-source consecutive-failure counters; advisory sources (`tick-gate`, `market-data`, `database`, `tool`) back off but never trigger shutdown — only `llm`, `redis`, `sandbox`, and `startup` are shutdown-eligible. `runTick` wraps the tick-gate phase in its own try/catch routed to `handleRuntimeFailure('tick-gate', ...)`.

- Agent observability (2026-06-11): added a canonical agent activity feed, a typed agent timeline, and agent-aware recent activity views in Mission Control and Activity.

- More tools (2026-06-11): added task, reminder, memory, and document-reading tools, plus email fanout for allowed agent messages.

- Always-on market intelligence (2026-06-10): added leader-owned discovery polling, market monitor evaluation, wake coalescing, and market event protocol support.

- Web access tools (2026-06-11): added `search_web` and `browse_url` for Tavily-backed internet search and HTML page reading, plus the `research` skill, capability grants, SSRF/content-type safeguards, and agent runtime config wiring.

- Agent controls and cadence (2026-06-10): added configurable tick interval, capital, and LLM budget handling across API, web, and worker runtime.

- Improved connection and credential handling (2026-06-10): added guided provider-link setup from Mission Control and Create Agent, with a transactional setup endpoint and explicit trading provisioning.
- Web i18n (2026-06-10): full react-intl migration — locale provider, EN/AR/HI catalogs, locale selector in Settings, server-persisted preference, structured API error codes with interpolation params, activity event message keys, shared formatting helpers (`formatShortDate`, `formatCurrencyFromCents`). See ADR 002.
- `preferred_locale` column on `users` table (migration `0001_add_preferred_locale`): stores the user's chosen UI language; synced to client on session bootstrap.

### Changed

- Agent naming for Telegram (2026-06-15): agent create and update validation now reserves `all` and `*` for Telegram broadcast targeting.

- Telegram webhook configuration (2026-06-15): Telegram webhook authentication now uses a dedicated `alerts.telegram.webhookSecret`, and workers can register the configured `alerts.telegram.webhookUrl` with Telegram at startup.

- Agent runtime loop controls (2026-06-15): scout/judge turn caps and temperatures, scout token budget, wake timing, and venue-intelligence fanout caps are now operator-configurable through `agentRuntime` and forwarded into container runtime policy.

- Usage billing activation (2026-06-15): worker usage accounting no longer depends on a routine `USAGE_BILLING_ENABLED` container toggle, and the operator config surface no longer exposes `usageBilling.enabled`.

- Agent wake semantics (2026-06-15): wake payloads now require typed sources end-to-end, reminder wakes no longer use legacy `reminder:` prefixes, and runtime reminder rendering depends on typed source/context instead of migration fallbacks.

- Provider registry for credentials and connections (2026-06-15): the API now publishes a typed provider catalog, credential and connection validation flow through the shared registry, and the web setup/credential/connection forms render from runtime provider metadata instead of hard-coded provider suggestions.

- **Migration squash (2026-06-10):** The 13 incremental migration files `0000_windy_serpent_society` through `0012_execute_code_programming_skill` were replaced with a single baseline (`0000_baseline.sql`) that represents the full schema at this point. Migration `0001_add_preferred_locale` is additive on top.
  - **Fresh databases:** run `pnpm --filter @herobids/db run migrate` as normal.
  - **Existing databases that ran the old migrations:** run `bash scripts/shell/ops/apply-db-squash-fixup.sh` once, then run `pnpm --filter @herobids/db run db:migrate`. The helper records the new baseline hash in `drizzle.__drizzle_migrations` so the squashed baseline is skipped and `0001_add_preferred_locale` can apply safely.

### Fixed

- Swap recovery confirmation handling (2026-06-15): restored filled-quantity and fill-timestamp recovery to match live swap execution semantics.

- Graceful agent deployment (2026-06-15): worker startup now stops existing agent containers before deleting them, giving runtimes a SIGTERM window during redeploys.

- Runtime state alignment (2026-06-15): runtime session retirement now preserves `crashed` vs `stopped`, and Docker fallback handling skips duplicate crash processing once an abnormal end is already recorded.

- System skill sync (2026-06-15): API startup now upserts platform-owned skills and revisions from `SYSTEM_SKILLS`, and functional reseed helpers reuse the same sync path.

- Production readiness hardening (2026-06-15): fail-closed agent grant fallback now rejects missing agent rows, bot and agent config updates validate execution capability at write time, actor health snapshots now cover bots and agents with refreshes instead of expiring to stale state, and decision failures are durably recorded for stale-session, missing-context, missing-position, and pre-execution rejection paths.

- Worker tick reliability (2026-06-12): tightened tick-gate fallback handling, preserved degradation metadata across skip branches, and added agent-level coverage for non-trading tick guard behavior.

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