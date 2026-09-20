# Trading & Trading-Adjacent Logic Remaining in herobids — Ownership Audit

- **Date:** 2026-09-18
- **Status:** INFORMATIONAL — inventory only. This audit deliberately does **not** decide what stays in herobids vs moves to traderton; it sets the stage for that decision by mapping *what* trading-semantics-bearing code, data, config, and UI remain in herobids, *where* they live, *who* consumes them, and *how coupled* they are — in particular to the LLM/agent-runtime core.
- **Motivation:** The extraction moved trading execution behind the traderton boundary ("herobids agents are generic agents consuming external trading capabilities"). Recent work (bug 2026-09-17 #001 phases 2–3) added two consumer-side seams that re-raise the ownership question: the boundary's lazy agent-direct actor construction, and the per-decision payload injection of `capital`/`riskPosture`/`riskOverrides` (the `agent.capital` smell — an agent that *has* capital is not a generic agent). Before deciding the end-state, we need the complete picture.
- **Method:** Four parallel read-only exploration passes (worker logic; domain/db/config surface; API/web surface; LLM-coupling graph), cross-checked against `traderton/packages/*` for counterpart files. Line refs are as of the audit date and will drift.
- **Companion:** `docs/bug-reports/2026/09/17/001-*` (the fixes that surfaced the question); traderton `docs/bug-reports/2026/09/17/001-*` (phase 2–3 detail).

---

## 1. Executive orientation

Three tiers of trading residue exist in herobids:

1. **Intentional consumer-side seams** (expected to stay): the traderton REST client/adapters, tool definitions that proxy the boundary, the approval UX, the capability/connection model, the LLM tick loop that *consumes* trading state.
2. **Duplicated authority** (the ownership question's core): values and logic where *both* repos hold a copy — risk contract math, `agentRiskDefaults`, strategy presets, watch/scan/gate type layers — plus values that are *stored* in herobids (`agents.capital/risk/riskOverrides`) but *enforced* in traderton via per-call payload echo.
3. **Dormant remnants** (deletion candidates regardless of the ownership decision): engine-era modules with no runtime importer in herobids (instrument/swap validation, candle resilience), transitional fallbacks (in-process `get_risk_limits` read, local-Redis `list_watches`), dead config blocks, orphaned tests, vestigial repositories.

The LLM coupling finding in one line: **trading data reaches the LLM through eleven prompt cards and ~18 tool surfaces, and trading state *gates the LLM loop itself*** (tick gates keyed to positions/watches/regime, pre-scout escalations, hybrid evaluator) — so trading cannot be excised from herobids, but nearly all *facts* the LLM sees already arrive boundary-first. The coupling is deep but mostly **data-plane**, not logic-plane.

---

## 2. Master inventory — worker (`apps/worker/src`)

Legend for **Class**: `seam` = intentional consumer-side integration · `dupe` = traderton holds a counterpart copy (runtime authority there) · `dormant` = no production importer in herobids · `fallback` = transitional in-process path behind a boundary-first route · `platform` = deliberate platform capability (traderton has no counterpart). **LLM** = reaches the model (tool surface, prompt card, or gates the loop). **Boundary** = fail-closed over traderton REST (no in-process fallback).

| File | Purpose (1-line) | Class | LLM | Boundary | Traderton counterpart |
|---|---|---|---|---|---|
| `traderton/read-adapter.ts` | Read-boundary port; binds HMAC client + subject | seam | – | is the boundary | server side = traderton boundary pkg |
| `traderton/write-adapter.ts` | Side-effect invoke + poll-to-deadline port | seam | – | is the boundary | idem |
| `traderton/hybrid-price-adapter.ts` | PriceService backed by `resolve_price_target` | seam | indirect (hybrid sizing) | yes | `tools/price.ts` serves it |
| `traderton/price-contracts.ts` | Type-only PriceService contracts (copied) | dupe (types) | – | – | runtime authority in traderton |
| `tools/trading.ts` | `submit_decision` tool: validate → `DECISION_SUBMIT` → BLPOP reply | seam | **yes** (tool) | via broker→handler | **yes** (parity schema incl. venueAccountId/capital/risk fields) |
| `tools/account.ts` | `get_account_summary` | seam | **yes** | yes | yes |
| `tools/risk-limits.ts` | `get_risk_limits` + `adjust_risk_limits` | seam | **yes** | read+write: both fail-closed over the boundary (A6 removed the in-process read fallback) | yes |
| `tools/bots.ts` | bot lifecycle + reads (broker `MANAGE_BOT` / boundary reads) | seam | **yes** | yes | yes (+ traderton-only owner reads) |
| `tools/market-data.ts` | `search_tokens`/`discover_tokens`/`check_regime`/`get_funding_rates`/`get_market_overview` | seam | **yes** | yes | yes |
| `tools/price.ts` | `get_price` + chain/symbol validation helpers | seam | **yes** | yes | yes |
| `tools/find-instrument.ts` | `find_instrument` (instruments table = traderton-owned) | seam | **yes** | yes | yes |
| `tools/watch.ts` | `watch_token`/`list_watches`/`remove_watch`/`check_watches` | seam | **yes** | all four fail-closed over the boundary (A6 removed the `list_watches` local-Redis fallback) | yes |
| `tools/analytics.ts` | `get_analytics`, `list_positions` | seam | **yes** | yes | yes |
| `tools/resolvers.ts` | `resolve_bot` + `resolve_watch` (both boundary reads → in-app substring match), `resolve_task` (platform task store, non-trading) | seam | **yes** | yes (A6 re-pointed `resolve_watch` off the legacy local Redis hash) | resolve_task only (its own platform store) |
| `tools/assess-strategy-preset.ts` | preset assessment request (platform assessor) | platform | **yes** | evidence via SYSTEM boundary | none (DELETE-side) |
| `tools/change-strategy-preset.ts` | apply preset transition (platform DB) | platform | **yes** | – | none (DELETE-side) |
| `tools/platform-docs-data.ts` | static docs incl. large trading sections | platform | **yes** | – | none |
| `tools/traderton-read.ts` | boundary result→ToolResult mapping (fault classification) | seam | – | – | n/a |
| `agents/agent-decision-handler.ts` | session/approval gates; boundary submit; **risk payload injection** | seam | indirect | fail-closed | traderton owns intake/execution |
| `agents/decision-boundary-mapping.ts` | payload builder incl. `AgentRiskInjection` | seam | – | – | schema parity in traderton tool |
| `services/approval-service.ts` | approve→execute over boundary (current risk via resolver) | platform (approval UX deliberately consumer-owned; traderton deleted its copy) | – | fail-closed | none (deliberate) |
| `agent-risk-limits.ts` | risk contract/profile resolution + engine-shaped builder | **dupe** | indirect (fallback read) | – | **yes** (parity-tested) — RETIRED herobids-side under C2.2 (2026-09-20); traderton sole authority |
| `agent-risk-limits-contracts.ts` | `RiskLimits` type copy from traderton engine | dupe (types) | – | – | authoritative copy in `@traderton/engine` — RETIRED herobids-side under C2.2 (2026-09-20) |
| `hybrid-decision-sizing.ts` | USD→base sizing via PriceService | platform policy | indirect | price via boundary | none |
| `hybrid-agent-evaluator.ts` | single-shot LLM trade decisions on scanner wakes | platform (LLM) | **yes** | decision→broker→boundary | none |
| `validate-trade-instrument.ts` | venue-aware instrument validation | **dormant** | – | – | **yes** (live in traderton actor) |
| `swap-instrument-id.ts` | swap instrument ID parser | **dormant** | – | – | yes (live) |
| `resolve-swap-assets.ts` | binding→SwapAssets/network | **dormant** | – | – | yes (live) |
| `swap-startup-validation.ts` | swap scanner config validation | **dormant** | – | – | yes (live) |
| `venue-instrument-cache.ts` | per-venue symbol cache (validation gate) | near-dormant (assessment resolver only) | – | – | yes (live, fed by real adapters) |
| `candle-fetch-breaker.ts` | scan candle circuit breaker | **dormant** (test-only) | – | – | yes (live) |
| `candle-fetch-retry.ts` | retry/backoff helper | **dormant** (test-only) | – | – | yes (live) |
| `position-coverage.ts` | watch↔position protective coverage evaluation | platform analysis | indirect (prompt card + escalation) | inputs via boundary | **yes** (parity copy) |
| `agent-watch-view.ts` / `watch-types.ts` | watch parse/view layer | dupe (types/parse) | indirect | – | `watch-types.ts` yes |
| `scan-types.ts` | scan DTO types consumed from traderton messages | dupe (types) | indirect | – | yes (traderton's is superset) |
| `tick-gates.ts` | skip-tick engine + **trading-session hours table** | dupe+platform | indirect (**gates LLM**) | regime/vol callbacks via boundary | **yes** (parity incl. session hours) |
| `tick-gate-state.ts` | per-tick gate state builder | dupe | indirect | – | yes |
| `agent-capabilities.ts` | `trading` capability family gating of tick work | platform | indirect | gates boundary work | none |
| `venue-intelligence.ts` | boundary payload parsers + venue signal derivations | platform | indirect (prompt card) | parses boundary payloads | none (served by traderton) |
| `agents/agent-message-broker.ts` | inbound broker; `MANAGE_BOT`→boundary; `applyAgentCapitalLimit`; mode-rank gate | seam+platform gates | indirect | fail-closed | none (broker is consumer-side) |
| `agents/capability-policy.ts` | tiered grants for `submit_decision`/`manage_bot`/`venue_api(never)` | platform | indirect | – | none |
| `alerting/boundary-trade-event-feed.ts` | trade-event reads for alerting | seam | – | yes | served by `tools/bots.ts` |
| `market-intelligence/*` (coordinator, monitor, evidence-adapters, platform-assessor, llm-ranker, preset-*, review-*) | regime/discovery/wake machinery + billable preset assessment | platform | indirect (wakes) | evidence boundary fail-closed | none (traderton serves data) |
| `agent-evaluation/*` | trading evidence via boundary (`get_agent_fills/positions/journal`) | seam | – | fail-closed | served |
| `runtime-composition.ts` (trading parts) | trading prompt cards + runtime state | platform (LLM) | **yes** (11 cards) | inputs via boundary | partial (DTO mirrors only) |
| `hybrid-agent-prompt.ts` | hybrid prompt: capital/positions/scan/venue + sizing cap hint | platform (LLM) | **yes** | – | none |
| `tick-thinking.ts` | reasoning depth from drawdown/positions | platform | indirect | – | none |
| `scout-gating.ts` | forced escalations from positions/watches/coverage | platform | indirect (**gates LLM**) | inputs via boundary | none |

### `agent.ts` trading sections (the runtime's spine)

| Lines (≈) | Section |
|---|---|
| 239–330 | `AgentConfig` trading fields: `executionMode` (deprecated), `dailyLossLimit`, `maxDrawdownPct`, `maxBots`, `maxSlippageBps`, `maxOpenPositions`, `maxPositionSizePct`, `stopLossPct`, `stopLossCooldownMs`, **`capital`**, `agentRiskDefaults` (17 fields), `openPositionEscalationToJudgePolicy`, `risk` (RiskPosture), `tradingSessions` |
| 334–344, 415–421 | trading-hours config parse (`TRADING_HOURS_JSON` / runtime policy) |
| 475–514 | descriptor: trading-skill detection, `executionMode` default, **guardrails incl. `capital`** |
| 557–565 | `configuredCapitalUsd` ← `agentConfig.capital` → portfolio summary |
| 787–845 | watch loads (boundary-first, local fallback) |
| 954–1032 | boundary construction + **fail-fast guard** (trading agent w/o boundary) + market-data tool hiding |
| 1095–1410 | trading providers; open positions via boundary; venue-intelligence refresh via boundary |
| 1736–1822 | `buildRiskContractOps()` — in-process contract read (`getRiskOverrides`, capital/risk, ceilings); `adjustOverrides` in-process write (dead at tool layer) |
| 1956–2015 | `toolContext`: executionMode, boundaries, riskContractOps, executionConfig; narrow `agentRepo.getAgent → {capital, risk}` |
| 2628–2800 | wake drain + per-tick positions/watches/risk digests (gate inputs) |
| 2820–2926 | regime/volatility callbacks over boundary |
| 3092–3270 | hybrid evaluator routing, billing gate (positions), `maxPositions`, `submitDecision` callback (go_flat / sized go_long via boundary price) |
| 3355–3388 | economic calendar read; active-watch summary |
| 3477–3560 | watch-notify dedup, position coverage eval, pre-scout escalation inputs |

---

## 3. Master inventory — domain, data, config (`packages/*`, `config/*`)

### 3.1 Domain types (`packages/domain/src`)

| Module | Trading semantics | Traderton counterpart |
|---|---|---|
| `trading/tool-contract.ts` | `ToolCategory` (execute-trade…), `TradingToolContext` (executionMode, risk ports, boundaries), `TradertonReadResult` | ✅ near-identical copy |
| `trading/trading-protocol.ts` | watch purpose taxonomy; wake/context schemas; **trading-session names** | ✅ identical |
| `trading/venue-capability.ts` | TimeInForce/venue capabilities | ✅ identical (dormant in herobids) |
| `trading/execution-capability.ts` | venueType mapping; paper+swap rejection | ✅ identical |
| `trading/mode-rank.ts` | paper/shadow/live escalation guard | ✅ identical |
| `trading/actor-health.ts` | actor health snapshot schema | ✅ identical |
| `agent-risk-contract.ts` | the 5+4-field risk contract/profile + validators | ✅ identical |
| `agent-protocol.ts` | `DecisionSubmitPayloadSchema`, decision reply schemas, `HybridAgentDecisionSchema` | partial (traderton keeps a 3-const authored subset) |
| `tools.ts` / `tool-schemas.ts` | 63-tool catalog (≈25 trading tools); trading JSON schemas incl. bot strategy/risk params, `submit_decision.targetSize` | catalog ❌ (platform); schemas ✅ |
| `skills.ts` | **`BASE_SKILL.requiredTools` includes `get_risk_limits` + `get_account_summary` (every agent)**; `TRADING_SKILL`/`BOT_MANAGEMENT_SKILL`/`RISK_MONITORING_SKILL`; preset map | ❌ (platform concept) |
| `config/schema.ts` | `RiskPostureSchema`, `AgentRiskDefaultsSchema`, `BotConfigSchema`, `StrategySchema`, `TradingHoursConfigSchema`, `BoundaryConfigSchema`, venue lists | ✅ copied (traderton adds mechanical-only + live-rollout divergences) |
| `scanner-types.ts`, `market-assessment.ts` | scan identities; preset assessment/transition state machines | ✅ near-identical / shared tables |
| `models/decision.ts`, `values/*`, `enums.ts` | Decision entity, branded ids, Price/Quantity, order/intent enums | ✅ identical (live in traderton engine; dormant here) |
| `traderton/` (client/contract/sign) | **consumer-side REST client** (HMAC, invoke/poll) — kept out of the web bundle via subpath export | server side = traderton boundary pkg |
| `provider-catalog.ts` | which providers are `trading`/`swap` | ❌ platform-only (traderton has its own live-venue allowlist — authored independently, see §7-S7) |

### 3.2 Data (`packages/db/src`) — trading-semantics tables/columns

**Dropped from herobids (truth now in traderton):** `bots`, `venue_accounts`, `user_credentials` (trading half), `fills`, `positions`, `journal_events`, `orders`, `execution_plans`, `decisions`, `balance_snapshots`, `reconciliation_events`, `instruments`, `backtest_runs`, `llm_decision_artifacts`, `decision_contexts`, `decision_failures`, `token_safety_overrides`, `portfolios`, `agent_instance_links`.

**Retained in herobids with trading semantics:**

| Table/column | Semantics | Live consumers | Traderton counterpart |
|---|---|---|---|
| `agents.capital` (numeric) | **deployable trading allocation (USD)** | API create/PATCH; broker capital clamp; risk resolution; **boundary payload injection**; evaluation; web form | ❌ none (locked: no agents table) |
| `agents.risk` (RiskPosture jsonb) | creator risk posture (9 fields) | API validation; risk resolution; payload injection | ❌ (shape mirrored only) |
| `agents.riskOverrides` (jsonb) | runtime overrides (5 fields) | risk resolution; payload injection | ❌ |
| `agents.executionDefaults` (mode + slippage) | execution mode per agent | API; session manager; evaluation | ❌ (payload-injected) |
| `agents.maxBots`, `openPositionEscalationToJudgePolicy`, `wakePreferences`, `strategy` | bot cap; escalation policy; wake sources; strategy identity | API; worker gating; preset resolver | ❌ |
| `connections.provider / credentialId / resolvedVenueAccountId` | trading link; **soft ref to boundary-owned venue account** | capabilities readiness; bots create; provider-links teardown; connections UI | venue_accounts live in traderton (the FK target) |
| `platform_credentials` | **non-trading** secrets only (gmail) | OAuth routes | trading half = traderton `user_credentials` |
| `decision_approvals` | approval lifecycle (shortCode, instrumentId, intent, targetSize, levels, venueAccountId, proposedPayload, executionStatus) | agents routes; Telegram /yes /no; worker handler+service | ❌ **deliberately removed from traderton** (consumer-owned decision) |
| `market_assessment_artifacts` / `_runs` | preset assessment results keyed by trading identity | worker assessor; API billing | artifacts ✅ shared; runs ✅; `_requests` ❌ |
| `agent_scan_candidates`, `agent_scan_metrics`, `agent_preset_transitions`, `agent_preset_bindings`, `review_advice`, `agent_assessment_review_*` | platform assessment subsystem carrying instrumentKind/venueFamily/symbol | worker market-intelligence | ❌ platform-only |
| `blueprints.venueType/strategyType` + revision payloads | marketplace templates carry full bot trading config | API blueprints; web | ❌ platform-only |
| `chat_threads.setupContext` | guided-setup summary (venue, capital, preset) | chat routes | ❌ |
| Remnant code shape-mirrors | `exports-traderton.ts` re-declares `FillRow/JournalRow/PositionRow` byte-identically; orphaned `blueprints.integration.test.ts` TRUNCATEs dropped tables | – | real tables in traderton |

### 3.3 Config (`config/*.yaml`) & env

| Block | Trading semantics | Readers | Traderton counterpart |
|---|---|---|---|
| `venues:` (hyperliquid/bybit/jupiter/1inch) | URLs, rate limits, **walletGeneration**, operator platform keys | provider catalog, wallet-gen gating, validation | ✅ own copy (actively consumed by *its* adapters) — herobids copy now mostly drives wallet-generation only |
| `execution:` | slippage/timeouts/shadow poll | **nearly dead**: only `defaultSlippageBps` (venue-defaults route) | ✅ live in traderton |
| `agentRiskDefaults:` | **17 operator risk fields incl. maxBots** | API validation + web auto-fill; worker ceilings | ✅ **verbatim duplication — both stacks read/enforce the same defaults** |
| `boundary:` | traderton REST consumer config (HMAC) | API+worker composition roots | server-side env mirror |
| `agentApprovals:` | approval TTL + rate limit | interactivity + worker | ❌ |
| `strategy-presets/{economy,standard,premium}.yaml` | **full trading strategy parameter catalogs** (momentum/dca/range…, RSI/MACD, stop/TP, sizing) | domain presets-loader; assessor; API resolver | ✅ **fully duplicated catalogs** |
| `llm.tradingHours` | session-gate hours | worker session gate | ❌ |
| `agentRuntime.marketIntelligence` / `platformAssessor` / `scanner.swap` | watch/wake/assessment config | worker market-intel | partial (tokenSafety copies) |
| `plans.*.limits` (maxBots, maxVenueAccounts, liveEnabled) | plan entitlements over trading resources | plan-guards (venueAccounts counted **via boundary**) | ❌ |
| env: `TRADERTON_BOUNDARY_*`, `CREDENTIAL_ENCRYPTION_KEY`, `JUPITER/ONEINCH_API_KEY`, venue URL vars (worker-only readers), `BOUNDARY_CONFIG_JSON`/`TRADING_HOURS_JSON` (container-injected), script-level `VENUE/EXECUTION_MODE/HL_*`/… | boundary creds; encryption; wallet-gen; **venue URL vars with no live herobids consumer**; agent-container trading config injection | per env-example-drift guard | traderton has its own equivalents |

---

## 4. Master inventory — API & web surface

### 4.1 API routes/services (trading semantics)

| Surface | File(s) | Trading fields/flows | Boundary |
|---|---|---|---|
| Agent CRUD create/PATCH/GET | `routes/agents.ts` | capital, RiskPosture, executionDefaults.mode, authorizationMode, maxBots, strategyPreset, connectionIds; risk-defaults endpoint; capital⇒daily-loss coupling validation | none at create; delete cascades bots **via boundary (fail-closed)** |
| Approvals (web + Telegram) | `agents.ts`, `agent-interactivity.ts`, `telegram-slash-commands.ts` | pending list, approve (Redis→worker), /yes /no short codes | execution worker-side |
| Agent trading reads | `agent-interactivity.ts` (`GET /agents/:id/trades` — **no web consumer**), `capabilities/trading.ts` (positions/fills/journal/readiness/actions) | positions (exit-price reconstructed in-app), fills | agent-scoped reads fail-closed |
| Bots CRUD | `routes/bots.ts` | full lifecycle + owner reads (costs/sessions/events/journal) | mandatory on every handler |
| Provider-link setup/teardown | `routes/setup.ts`, `provider-links.ts` | trading branch: secrets canonicalized → `provision_venue_account` (wallet minted behind boundary); teardown `deprovision_venue_account` | fail-closed, compensating deletes |
| Connections | `routes/connections.ts` | `resolvedVenueAccountId` ⇒ trading; funding-address enrichment; delete guards via `count_bots_by_venue_account` | fail-closed |
| Exports / views / dashboard / analytics / billing fills / actor-health / reconciliation | `exports*.ts`, `views.ts`, `dashboard.ts`, `analytics.ts`, `billing.ts`, `actor-health.ts`, `reconciliation.ts` | trading evidence surfaces (several **no web consumer** — exports, /trading/fills, bot health) | mandatory |
| Guided chat | `routes/chat.ts` | trading prompt (capital/mode/preset), `create_connection`, **full parallel `create_agent` implementation** | provision only |
| Blueprints | `routes/blueprints.ts` | bot-kind instantiate = trading write (`instantiate_bot` outside local tx); performance scoring from positions | write + counts |
| Telegram commands | `telegram-command-handlers.ts` | /info /log /mode /golive… | /log best-effort (only tolerated boundary failure) |
| Go Live | `agent-go-live-service.ts` | clone-as-live with plan gates | none |
| Plan guards | `plan-guards.ts` | maxVenueAccounts via boundary count | yes |
| Crypto/credentials | `crypto.ts`, `providers/*` | **non-trading** secrets encrypted locally; trading secrets pass through to boundary payload | – |

**Boundary tool inventory called from herobids API+worker:** `provision/deprovision/count_venue_accounts`, `count_bots_by_blueprint`, `get_venue_account`, `create/start/stop/adjust/delete_bot`, `instantiate_bot`, `list_owner_bots`, `get_owner_bot_{status,costs,sessions,journal,journal_summary,fills,positions,reconciliation_events}`, `get_owner_{fills,journal,positions}`, `get_agent_{fills,positions,decisions,decision_failures,journal_events}`, plus the agent tool surface (`submit_decision`, `adjust_risk_limits`, watches, market-data, `get_account_summary`, `get_risk_limits`, `find_instrument`, `resolve_price_target`, `score_candidate`, `get_volatility`, `get_economic_calendar`).

### 4.2 Web UI surfaces

| Surface | Trading exposure | Framing |
|---|---|---|
| Create/Edit agent form (`AgentsPage.tsx`, `EditAgentModal.tsx`, `AgentFormBody`) | capital input (default 1000), daily-loss %, drawdown, max positions/position-size, stop-loss+cooldown, slippage, execution mode, authorization mode, venue picker, strategy preset, wake sources, escalation policy | **agent-property framing** ("Amount this agent may trade with") |
| Agent detail (`AgentDetailPage.tsx`) | trades panel, approvals panel, funding banner, lifecycle | mixed |
| Capability page (`AgentCapabilityPage.tsx`) | readiness state machine, connection bind/unbind, inline add-connection | **capability-config framing** |
| Connections page + setup forms | venue vs gmail, funding address, wallet-generation, manual keys, delete cascades | capability-config |
| Guided chat setup | wallet-created card, connection form actions, OAuth resume | capability-config |
| Bots pages, instance detail, exposure page, activity feed, outcome board, blueprints flow, public docs, admin | bot CRUD, positions/journal, aggregate exposure, trading events, presets, venue docs, vestigial bot stats | mixed |

**Bridge:** the create form embeds a venue picker (capability config) inside the agent-property form; funding/wallet steps launch mid-agent-creation. The two framings coexist and interleave — the audit's key UX fact for the ownership discussion.

---

## 5. Dependency diagram — how coupled is trading to the LLM core?

### 5.1 Module-level graph (condensed; `→` = imports)

```mermaid
graph TD
    subgraph LLM core
        AGENT[agent.ts<br/>tick loop]
        RTC[runtime-composition.ts<br/>prompt cards/state]
        TOOLLOOP[structured-tool-loop.ts]
        SCOUT[scout-dispatch / scout-gating]
        THINK[tick-thinking.ts]
        HYB[hybrid-agent-evaluator.ts<br/>+ prompt + sizing]
    end

    subgraph Trading tools (LLM surface)
        TOOLS[tools/* trading.ts bots.ts watch.ts<br/>risk-limits.ts account.ts market-data.ts<br/>price.ts analytics.ts find-instrument.ts]
        TREAD[tools/traderton-read.ts]
    end

    subgraph Risk
        RISK[agent-risk-limits.ts<br/>+ contracts]
        RCONTRACT["@herobids/domain<br/>agent-risk-contract.ts"]
    end

    subgraph Boundary seams
        RAD[traderton/read-adapter]
        WAD[traderton/write-adapter]
        HPA[traderton/hybrid-price-adapter]
        DT["@herobids/domain/traderton<br/>(REST client)"]
    end

    subgraph Decision path
        DH[agent-decision-handler.ts]
        MAP[decision-boundary-mapping.ts]
        BROKER[agent-message-broker.ts]
        APR[approval-service.ts]
    end

    subgraph Platform market intel
        MI[market-intelligence/*<br/>coordinator/monitor/assessor]
        EV[agent-evaluation/*]
    end

    subgraph Gate/coverage
        GATES[tick-gates.ts + state<br/>session hours]
        COV[position-coverage.ts]
        VI[venue-intelligence.ts]
        WV[agent-watch-view/watch-types]
    end

    AGENT --> TOOLLOOP
    AGENT --> RTC
    AGENT --> SCOUT
    AGENT --> THINK
    AGENT --> HYB
    AGENT --> TOOLS
    AGENT --> RISK
    AGENT --> GATES
    AGENT --> COV
    AGENT --> VI
    AGENT --> WV
    AGENT --> RAD
    AGENT --> WAD
    AGENT --> HPA
    AGENT --> MI
    RTC --> COV
    RTC --> RCONTRACT
    SCOUT --> VI
    GATES --> RTC
    HYB --> RTC
    HYB --> HPA
    TOOLS --> TREAD
    TREAD --> DT
    RAD --> DT
    WAD --> DT
    HPA --> RAD
    TOOLS --> RISK
    BROKER --> WAD
    BROKER --> TOOLS
    DH --> MAP
    DH --> WAD
    DH --> RCONTRACT
    APR --> MAP
    APR --> WAD
    MI --> RAD
    EV --> RAD
    MAP --> RCONTRACT
    RISK --> RCONTRACT
```

**Reading it:** the LLM core's trading coupling runs through four channels — (1) the **tool surface** (`tools/*` → boundary), (2) **prompt cards + gates** (runtime-composition/tick-gates/coverage/venue-intelligence — all data-plane, boundary-sourced), (3) the **hybrid evaluator** (an LLM call that *is* a trading decision), and (4) the **decision execution path** (broker/handler/approval → boundary). `structured-tool-loop.ts` and `llm-selection.ts` are trading-agnostic — the loop executes tools via callback and never imports a trading module directly.

### 5.2 LLM-loop coupling specifics (the "how coupled to LLM" answer)

1. **LLM dispatch is keyed to trading state.** `computeDecisionContextHash` hashes `positionSide`, `latestPrice`, `portfolioPnlUsd`, instrument snapshots, watch/risk-playbook/market digests (`tick-gates.ts:266-330`); the session gate (hard-coded asia/london/ny hours table) skips ticks outside configured sessions when no positions are open. Trading state *decides whether the model runs*.
2. **Trading values rendered into prompts** (11 trading-gated cards in `runtime-composition.ts`): guardrails (capital, limits), portfolio summary, open positions, position coverage, active watches, regime, technical scan, venue intelligence (incl. **held sizes from open positions**), macro events, performance, trading-venue/readiness. Hybrid prompt additionally computes a **per-position sizing cap** (`capital / maxPositions`) and suggests it to the model.
3. **Trading gates escalation & reasoning depth**: pre-scout forced escalations (watch triggered, uncovered position, stale protective coverage, open-position policy), and `tick-thinking.ts` deepens reasoning on drawdown breach / lightens when positions exist.
4. **`BASE_SKILL` gives EVERY agent trading read tools** (`get_risk_limits`, `get_account_summary`) with instructions to fetch capital before sizing — a personal-assistant agent carries trading-account tools on its LLM surface (in-process fallback reads `agents.capital/risk` directly).
5. **Wake pipeline is trading-data-driven**: watch_threshold/discovery_delta/regime_change/scanner wakes drive early ticks; five market-context cards are **not** trading-family-gated (they render for any agent if such a wake arrives).
6. **The LLM never sees execution internals**: no engine, planner, executor, or venue adapter is imported by any LLM-facing module — enforcement is delegated via the signed decision payload. Coupling is *data-in / decision-out*, not control.

### 5.3 Coupling counts for the ownership discussion

- Files in worker with trading semantics: ~45 (of which ~12 dormant/fallback remnants, ~14 parity-duplicated with traderton, rest = seams/platform).
- Prompt cards trading-gated: 11 (+5 ungated market-context cards).
- LLM-visible trading tools: ~18 (incl. 2 in base skill).
- Values crossing the wire per decision (the trust-echo channel): `venueAccountId`, `capital`, `riskPosture`, `riskOverrides` (+ decision fields).
- Duplicated config authority: `agentRiskDefaults` (17 fields), strategy-preset catalogs (3 files), risk-contract math (parity-tested), watch/scan/gate type layers.

---

## 6. Dormant / remnant register (deletion candidates independent of ownership)

| Item | Evidence | Outcome (A5) |
|---|---|---|
| `validate-trade-instrument.ts`, `swap-instrument-id.ts`, `resolve-swap-assets.ts`, `swap-startup-validation.ts`, `candle-fetch-breaker.ts`, `candle-fetch-retry.ts` | no production importer (tests only); live counterparts in traderton actor | **deleted** |
| `venue-instrument-cache.ts` | only consumer = assessment identity resolver (fail-closed there) | **kept** — consumer `AssessmentIdentityResolverImpl` itself dormant (no production constructor); out of A5 scope, flagged |
| `buildAgentRiskLimits`/`buildRiskLimitsFromContract` in `agent-risk-limits.ts` | test-only (engine math lives traderton-side) | **kept** — `RiskLimits` seam still imported (A3 payload-bound RiskSource until B1); DELETED herobids-side in C2.2 (2026-09-20) |
| `riskContractOps.adjustOverrides` (in-process risk write via `setRiskOverrides`) | dead at tool layer (adjust is boundary fail-closed) | **deleted** (write path); read path (`getContract`/`getProfile`) kept |
| `ctx.executionConfig` affordance | constructed, never read by a tool | **deleted** |
| `tools/resolvers.ts` `resolve_watch`/`resolve_task` | local-Redis legacy stores (watch state is traderton-owned) | (deferred — A6 decides) |
| `execution:` config block | only `defaultSlippageBps` live | **deleted** except `defaultSlippageBps` |
| Worker venue URL env vars (`HYPERLIQUID_*`, `BYBIT_*`, …) + `SOLANA_RPC_URL`/`BASE_RPC_URL` | no live consumer (adapters removed) | **deleted** |
| `blueprints.integration.test.ts` | TRUNCATEs dropped tables (known orphan) | (deferred — Plan 005 §9) |
| `routes/exports-traderton.ts` row mirrors | hand-maintained schema of traderton-owned tables | (deferred — serving exports) |
| `GET /agents/:id/trades`, exports endpoints, `GET /trading/fills`, bot health routes | no web consumer | `trades` **deleted**; exports **kept**; `/trading/fills` **deleted**; bot-health **kept** |
| `BotRepository` | reduced to `isConnectionOwnedBy` | **renamed** → `ConnectionOwnershipRepository` |
| deprecated `scout-gating.hasUncoveredTrackedPosition`, stale docs refs (`complete-technical-scan.ts`), preset-scorecard TODO | superseded/stale | **deleted** / docs fixed |

---

## 7. Surprises register (cross-cutting observations)

1. **Base skill injects trading read tools into every agent** (incl. non-trading) — the strongest LLM-surface coupling finding.
2. **Risk values cross the wire as a consumer echo** (`capital/riskPosture/riskOverrides` in the signed payload) — the enforcement-trust question from the 09-17 discussion; traderton believes per-request numbers it cannot independently verify.
3. **`agentRiskDefaults` + strategy-preset catalogs are duplicated wholesale** in both repos — two independent operator surfaces for the same semantics.
4. **Risk contract math is parity-duplicated** (agent-risk-limits.ts ↔ traderton; parity tests on both sides).
5. **Agent delete requires the trading boundary** (bot teardown runs unconditionally, fail-closed) — even a botless agent can't be deleted without traderton.
6. **In-app exit-price reconstruction** in capabilities/trading positions (O(positions×fills) correlated-scan parity).
7. **Two parallel agent-update routes** (PATCH agents.ts + PUT agent-interactivity.ts) and a **parallel chat create_agent** — three create/update codepaths carrying the same trading-field semantics.
8. **Wallet custody copy** in UI asserts platform-held keys ("OpenAIdom holds this generated direct-wallet signing key encrypted") while minting happens behind the boundary.
9. **Daily-loss framing inconsistency**: UI says "% of equity", public glossary says "Set in USD".
10. **Venue allowlists authored independently**: herobids `PROVIDER_CATEGORIES` vs traderton `SUPPORTED_LIVE_VENUES`/`liveRollout`.
11. **`agent.technical.scan_completed` DTO mirrored** (scan-types) — traderton produces, herobids consumes.
12. **Admin UI still renders "Total Bots"** though server dropped cross-tenant bot counts (c4.7).
13. **Approval lifecycle is deliberately consumer-owned** (traderton deleted its `decision_approvals`) — an explicit prior ownership decision to use as precedent.
14. **Wake-context cards ungated by capability family** — any agent's prompt can receive watch/discovery/regime context if a wake arrives.
15. **`chat_threads.setupContext` persists venue/capital/preset** — trading state in a chat table.

---

## 8. The decision this audit sets up (not made here)

The inventory clusters the residue into five questions for the follow-up decision doc:

1. **Stored trading state** — `agents.{capital, risk, riskOverrides, executionDefaults, maxBots}` (+ chat setupContext): property framing vs allocation framing (e.g. a traderton-owned trading profile per (owner, actor, venueAccount), configured through the boundary from herobids' UI — the provision-via-boundary pattern; also resolves the payload-echo trust gap and `get_account_summary` degradation).
2. **Duplicated authority** — agentRiskDefaults, preset catalogs, risk-contract math, watch/scan/gate type layers: single-source vs continued parity duplication.
3. **Dormant remnants** — the §6 register (safe to delete under either answer).
4. **LLM-surface placement** — base-skill trading tools, hybrid evaluator + sizing policy, preset assessment: platform brain (consume trading capability) vs trading-adjacent; and whether non-trading agents should carry trading read tools at all.
5. **Fallback paths** — in-process `get_risk_limits` read, local-Redis `list_watches`/resolvers, exit-price reconstruction: complete the boundary-first posture or keep as availability shims.

Each row in §2–§4 is intended to be citable in that future doc (e.g. "Q1 affects rows …"), so the decision can be made item-by-item with evidence rather than wholesale.

---

*Audit compiled 2026-09-18 from four parallel read-only exploration passes; no code was modified.*
