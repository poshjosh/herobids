# Frontend Crypto/Trading Text Inventory (E3 deliverable)

**Date:** 2026-10-01. **Revised:** 2026-10-02 — the four admin-only "Preview"
pages were **deleted** (see below), and this table now reflects only the text
that remains in the codebase.
**Status:** inventory only — **producing this table is the task; APPLYING it
(relabeling the remaining copy) is a LATER task** (operator decision P2-19, E3
resolved "keep as-is for now").
**Scope:** user-facing text in the herobids web frontend only
(`apps/web/src/app/i18n/locales/{en,ar,hi}.ts`, inline JSX in
`apps/web/src/**/*.tsx` excluding tests and `features/public-pages/**`, and
`apps/web/index.html`). Public-pages markdown is excluded (moved to Traderton in
T3.2).

## What was deleted (2026-10-02)

The sidebar **Preview** section (admin-only) and its pages were removed, along
with the text that became orphaned as a result. This was executed (operator
authorized removing orphaned text without further approval).

**Pages/components deleted:**
- `/bots` — `features/bots/` (`BotsPage`, `BotCustomConfigSection`)
- `/bots/:id` — `features/instances/detail/` (`InstanceDetailPage`)
- `/outcomes` — `features/outcomes/` (`OutcomeBoardPage`)
- `/exposure` — `features/exposure/` (`ExposurePage`)
- `/activity` — `features/activity/` (`ActivityFeedPage`, `ActivityItem`,
  `AgentActivityItem`, `activity-feed-items`)
- `features/trading-instances/InstancesPage` — orphaned (unrouted) dead page
- `features/timeline/` (`TimelineEvent`) — orphaned once `InstanceDetailPage`
  (its only consumer) was removed; `/agents/:id` uses a separate stack
  (`AgentActivityTimeline` + `agentsApi.activityFeed`), so nothing else needed it.
- `router.tsx` routes + imports; `Sidebar.tsx` Preview section (and its
  now-unused collapsible `SectionLabel` branch).

**i18n keys removed (across all 3 locales — en/ar/hi, 122 keys each):** the
whole `bots.*`, `exposure.*`, `outcomes.*`, `instances.*`, `instanceDetail.*`,
`activity.*`, and `timeline.*` blocks, plus `nav.bots`, `nav.exposure`,
`nav.outcomes`, `nav.activity`, `nav.preview`, and `nav.tradingSetup`.
Note: the `activity.<category>.<event>` message keys (e.g. `activity.order.filled`)
were also removed — their only consumer was the deleted `TimelineEvent`.

**api-client (`lib/api-client.ts`) removed:** the entire `dashboard` export
(`overview`, `activity`, `agentActivity`) and the now-unused types
`DashboardOverview`, `ActivityEvent`, `ActivityFeedResponse`. (`BotSummary`,
the `bots` client, `StrategyPresetSelector`, and the `AgentActivity*` contract
stay — still used by `/agents` and the health strip.)

**Tests updated:** `i18n-regressions.test.ts` lost its `BotsPage`,
`InstanceDetailPage`, and `InstancesPage` banned-string entries (files gone).
`catalog-consistency`, `sitemap-urls`, and the full web suite pass; `pnpm lint`
and the web build are green.

**Verification:** `pnpm lint` (root `tsc --noEmit`) ✅ · web build ✅ · web
vitest 663/663 ✅.

## Potential orphan keys NOT removed (reported for later review)

A full-literal sweep of the i18n catalog found ~213 further keys with no literal
reference. **These were deliberately left in place** because the frontend builds
many keys dynamically (e.g. `` `agents.executionMode.${mode}` ``,
`` `agents.eligibility.${x}` ``, `` `agents.technical.scan.signalBias.${x}` ``,
`` `status.${status}` ``, `` `billing.interval.${x}` ``,
`` `aiModels.reasoning.${level}` ``, `` `public.nav.${section}` ``), so a literal
"no match" does not prove a key is dead. Removing them safely requires per-key
dynamic-reach analysis — a separate task. One clearly-dead non-dynamic candidate
noted for later: `agentsApi.activity` (the `request<unknown[]>` method at
`api-client.ts` ~line 1218) has no callers; it predates this change and was left
untouched.

## How to read the "Proposed replacement" column

- A concrete capability-neutral rewrite is given where the text is simple
  product/onboarding copy that can be neutralized in place.
- `—` with "Deferred Phase-3 trading-feature move — N/A" means the text belongs
  to a whole trading FEATURE (agent trading capability, technical/strategy
  config, approvals, trade history) whose disposition is decided in Phase 3.
- "Neutral; keep" means the text is already capability-neutral.
- "Ambiguous — verify" flags strings that may be fine as-is.

## Notable findings

- **`index.html` is already capability-neutral except ONE phrase** — the JSON-LD
  `about.description` says "…from crypto trading to personal assistance." That
  single phrase is E3's actual trigger; the meta description, OpenGraph, and
  Twitter card copy are already neutral.
- With the Preview pages gone, the remaining trading copy lives on the **agent**
  surfaces (`agents.*`: executionMode / capability / controls / approvals /
  trades / technical.* / strategyReview / capabilityPage), plus
  `missionControl.*`, `setup.form.*`, `connections.*`, `credential.*`, and a few
  `agents.create.goalPlaceholder.*` onboarding strings — all on `/agents`,
  `/agents/:id`, `/agents/new`, `/connections`, and the dashboard.
- Inline (non-i18n) hardcoded trading text concentrates in 4 files:
  `features/setup/WalletCreatedStep.tsx`, `features/setup/ProviderSetupForm.tsx`,
  `features/agents/TradingCapabilityPresentation.tsx`,
  `features/blueprints/BlueprintInstantiateFlow.tsx`.
- Venue display names (Hyperliquid/Bybit/Jupiter/1inch) are NOT hardcoded UI
  copy — they come from the backend provider catalog — except example text like
  `setup.form.namePlaceholder` ("e.g. My Hyperliquid account") and
  `missionControl.setup.message` ("…like Hyperliquid or Gmail").

---

## I18n strings
`apps/web/src/app/i18n/locales/en.ts` — all have ar/hi twins. (Keys from the
deleted Preview pages no longer exist and are not listed.)

| Location (i18n key) | Current text (verbatim) | Proposed capability-neutral replacement | Notes |
|---|---|---|---|
| missionControl.metric.totalPnl | Total Realized P&L | Total outcome | Ambiguous — verify (dashboard metric) |
| missionControl.setup.message | Connect your AI agents to external platforms like Hyperliquid or Gmail. | Connect your AI agents to external platforms. | Hardcoded venue name in example |
| agents.executionMode.label | Execution mode | — | Operational mechanic; trading-adjacent |
| agents.executionMode.live | Live | — | Deferred Phase-3 — N/A |
| agents.capabilityFamily.trading | Trading | — | Deferred Phase-3 — N/A |
| agents.capabilityState.unconfigured.tradingNote | Paper trading works without this. Connect an external platform to enable live trading. | Connect an external platform to enable this capability. | Capability readiness note |
| agents.capabilityPage.tradingUnavailable | Trading details are unavailable until the selected connection is ready. | Capability details are unavailable until the selected connection is ready. | Capability page |
| agents.summary.pnl | P&L | — | Deferred Phase-3 — N/A (renders on /agents/:id) |
| agents.summary.tradeCount | {count, plural, one {# trade} other {# trades}} | — | Deferred Phase-3 — N/A (renders on /agents/:id) |
| agents.summary.winRate | Win: {rate, number}% | — | Deferred Phase-3 — N/A (renders on /agents/:id) |
| agents.create.goalPlaceholder | e.g. Grow this portfolio aggressively | e.g. What should your agent do? | Onboarding placeholder — trading framing |
| agents.create.goalPlaceholder.trading | e.g. Grow this portfolio | — | Deferred Phase-3 — N/A |
| agents.create.suggestedSkills.trading | Trading starter | — | Deferred Phase-3 — N/A |
| agents.create.executionMode.live | Live — real order placement | — | Deferred Phase-3 — N/A |
| agents.create.whereToTrade | Connect agent to external platform | — | Label keyed "whereToTrade"; neutral text |
| agents.create.setupTradingNow | Set up trading now | Set up now | CTA |
| agents.create.tradingControls.title | Trading guardrails | Guardrails | Section title |
| agents.create.connections.trading | Trading | — | Deferred Phase-3 — N/A |
| agents.controls.capital.help | Amount this agent may trade with — not the full wallet balance. | — | Deferred Phase-3 — N/A |
| agents.authorizationMode.label | Trade Authorization | Authorization | Label |
| agents.authorizationMode.directHelp | Trades execute immediately with no human review. Best when you trust the agent to act autonomously. | Actions execute immediately with no human review… | Help text |
| agents.authorizationMode.approvalRequiredHelp | Each trade proposal is sent to you for approval before any market action. Approve or reject from the web app or Telegram. | Each action proposal is sent to you for approval before execution… | Help text |
| agents.create.technicalPreFilter.help | Reduce cost by filtering trade options before AI agent sees them. | — | Deferred Phase-3 — N/A |
| agents.controls.dailyMaxLossPct (+ .help) | Daily loss limit (%) / Hard cap on rolling 24h realized loss… | — | Deferred Phase-3 — N/A |
| agents.controls.maxDrawdownPct (+ .help) | Max drawdown (%) / Hard cap on peak-to-current equity drawdown… | — | Deferred Phase-3 — N/A |
| agents.controls.maxSlippage | Max slippage (bps) | — | Deferred Phase-3 — N/A |
| agents.controls.maxOpenPositions (+ .help) | Max open positions / Hard cap on simultaneous positions… | — | Deferred Phase-3 — N/A |
| agents.controls.maxPositionSizePct (+ .help) | Max position size (%) / Max single position size as a percentage cap… | — | Deferred Phase-3 — N/A |
| agents.controls.stopLossPct (+ .help) | Stop-loss (%) / Force exit when unrealized loss exceeds this percent… | — | Deferred Phase-3 — N/A |
| agents.controls.stopLossCooldown (+ .help) | Stop-loss cooldown (sec) / Minimum wait after a stop-loss exit before re-entry… | — | Deferred Phase-3 — N/A |
| agents.controls.openPositionEscalationPolicy (+ .help + options) | Open Position Escalation / How often should the premium AI agent review open positions… | — | Deferred Phase-3 — N/A |
| agents.review.openPositionEscalationPolicy | Open Position Escalation | — | Deferred Phase-3 — N/A |
| agents.approvals.empty | No pending trade approvals. | No pending approvals. | Approvals panel |
| agents.approvals.rejected | Trade proposal rejected. | Proposal rejected. | Toast |
| agents.approvals.executionAccepted | Trade executed successfully. | Action executed successfully. | Toast |
| agents.approvals.executionRejected | Trade rejected by risk checks. | Action rejected by risk checks. | Toast |
| agents.approvals.instrument | Instrument | — | Deferred Phase-3 — N/A |
| agents.approvals.targetSize | Target Size | — | Deferred Phase-3 — N/A |
| agents.approvals.limitPrice | Limit Price | — | Deferred Phase-3 — N/A |
| agents.approvals.orderType | Order type | — | Deferred Phase-3 — N/A |
| agents.approvals.market | Market | — | Deferred Phase-3 — N/A |
| agents.approvals.stopLoss | Stop Loss | — | Deferred Phase-3 — N/A |
| agents.approvals.takeProfit | Take Profit | — | Deferred Phase-3 — N/A |
| agents.approvals.telegramHint | Or from Telegram: /yes {code} or /no {code} | — | Ambiguous — verify |
| agents.detail.fundingBanner.text | Your trading wallet may need funding before live trading. | — | Deferred Phase-3 — N/A (renders on /agents/:id) |
| agents.detail.tradesHistory | Trade History | — | Deferred Phase-3 — N/A (renders on /agents/:id) |
| agents.strategyReview.* (runReview, running, notAvailable, completeWithAdvice, adviceColumn.*, assessing, results.*) | Run Strategy Review / Strategy Assessment Results / Active Preset / Agent switched to {preset} … | — | Deferred Phase-3 — N/A (~15 keys; AgentEvaluations.tsx) |
| agents.trades.col.* + status/empty (token, venue, entry, exit, size, pnl, hold, mode, statusOpen, statusClosed, empty) | Token / Venue / Entry / Exit / Size / PnL / Hold / Mode / Open / Closed / No trade history yet. | — | Deferred Phase-3 — N/A (~11 keys; renders on /agents/:id) |
| agents.capability.hybrid.description | Indicators pre-filter trade options, LLM makes final call. | — | Deferred Phase-3 — N/A |
| agents.technical.* (title, preset.*, filterTrades, platformAssessment.*, filters.*, scan.signalBias.*, indicators.*, params.*) | Technical Configuration / Strategy preset / Momentum Breakout / Mean Reversion / Filter Trades / Periodic Strategy Assessment / Venue / RSI / MACD / CHOCH / Overbought / Oversold / Breakout threshold … | — | Deferred Phase-3 — N/A (~45 trading-specific keys) |
| agents.runtimePolicy.tradingSessionsLabel (+ Help + session.*) | Trading Sessions / Shortcuts for common market windows (Eastern Time)… | — | Deferred Phase-3 — N/A |
| agents.edit.dailyMaxLossPct / maxSlippage / maxBots | Daily loss limit (%) / Max slippage (bps) / Max bots | — | Deferred Phase-3 — N/A |
| agents.edit.intelligenceIgnoredWarning | Switching to Technical-only: the agent's LLM configuration … ignored at runtime … | — | Ambiguous — verify (capability mechanic) |
| plan.live_disabled | Live trading is not enabled on your current plan. | — | Deferred Phase-3 — N/A |
| credential.validation_error.invalid_wallet_address | Enter a valid wallet address for {venue}. | — | Deferred Phase-3 — N/A |
| credential.validation_error.invalid_private_key | Enter a valid private key for {venue}. | — | Deferred Phase-3 — N/A |
| connection.missing_venue_account | No venue account found for this connection. Please complete trading setup first. | — | Deferred Phase-3 — N/A (ConnectionsPage) |
| ai_invalid_config | AI response is missing required config sections (strategy, risk, execution). | — | Deferred Phase-3 — N/A |
| config_invalid | Bot config is invalid — cannot start. Fix the config before retrying. | — | Deferred Phase-3 — N/A |
| max_bots_reached | Agent has reached its maximum concurrent bots limit. Stop a bot before starting a new one. | — | Deferred Phase-3 — N/A |
| setup.form.standaloneSubtitle | Connect a trading exchange, email account, or custom integration. Secrets are encrypted and never stored in plain text. | Connect an exchange, email account, or custom integration… | Setup form subtitle |
| setup.form.group.trading | Trading | — | Deferred Phase-3 — N/A |
| setup.form.namePlaceholder | e.g. My Hyperliquid account | e.g. My account | Hardcoded venue name in placeholder |
| connections.cascadeDeleteConfirm | Delete connection "{label}" and its linked wallet record and stored credential/private key from OpenAIdom? … | — | Deferred Phase-3 — N/A (wallet-specific; ConnectionsPage) |
| connections.cascadeDeleteBlocked | Cannot delete the linked wallet data. Remove agent grants and bots first… | — | Deferred Phase-3 — N/A (ConnectionsPage) |
| connections.deleteBlockedByBots | Cannot delete this connection because it is referenced by bots: {blockingBotIds}. Delete the bots first. | — | Deferred Phase-3 — N/A (ConnectionsPage) |
| connections.fundingAddress | Funding address | — | Deferred Phase-3 — N/A |
| billing.usage.sectionTitle | AI Usage — Current Period | — | Ambiguous — verify (billing, not trading; likely keep) |

## Inline JSX text
Non-test `.tsx`, trading-specific hardcoded literals (not routed through i18n).
Note: several of these are hardcoded English (not internationalized).

| Location (file:line) | Current text (verbatim) | Proposed capability-neutral replacement | Notes |
|---|---|---|---|
| features/setup/WalletCreatedStep.tsx:12 | Fund this wallet with SOL on Solana mainnet before trading. | — | Deferred Phase-3 — N/A; hardcoded EN |
| features/setup/WalletCreatedStep.tsx:15 | Fund this wallet on Hyperliquid mainnet before trading. | — | Deferred Phase-3 — N/A; hardcoded EN + venue name |
| features/setup/WalletCreatedStep.tsx:17 | Fund this wallet on ${wallet.network} before trading. | — | Deferred Phase-3 — N/A; hardcoded EN |
| features/setup/WalletCreatedStep.tsx:30 | Wallet created (modal title) | — | Deferred Phase-3; hardcoded EN |
| features/setup/WalletCreatedStep.tsx:32 | OpenAIdom holds this generated direct-wallet signing key encrypted on your behalf. | — | Deferred Phase-3; hardcoded EN |
| features/setup/WalletCreatedStep.tsx:34 | Funding address | — | Deferred Phase-3; hardcoded EN |
| features/setup/WalletCreatedStep.tsx:39 | Trading starts only after the wallet is funded. Deposits are not bridged or confirmed automatically. | — | Deferred Phase-3; hardcoded EN |
| features/setup/ProviderSetupForm.tsx (wallet toggle) | Wallet / Use existing wallet / Create wallet | — | Deferred Phase-3; hardcoded EN |
| features/agents/TradingCapabilityPresentation.tsx:18–24 | Instrument / Intent / Target size / Limit price / Order type / Market / Stop loss / Take profit / Confidence | — | Deferred Phase-3 — N/A; hardcoded EN labels |
| features/agents/TradingCapabilityPresentation.tsx:102 | Trading details (SectionLabel) | — | Deferred Phase-3; hardcoded EN |
| features/blueprints/BlueprintInstantiateFlow.tsx | Strategy / Risk Profile / Risk overrides / Trading connections / "Select active connections for this agent to trade through." / "No trading connections selected…" / Max open positions / Max position size % / Stop loss % / Max drawdown % / Daily max loss % | — | Deferred Phase-3 — N/A; hardcoded EN |

## index.html SEO/OG/JSON-LD
`apps/web/index.html`

| Location | Current text (verbatim) | Proposed capability-neutral replacement | Notes |
|---|---|---|---|
| JSON-LD `about.description` | "…an autonomous agent gets it done for you — from crypto trading to personal assistance. Create your own personal assistant without managing servers, hosting, or agent infrastructure." | "…an autonomous agent gets it done for you. Create your own personal assistant without managing servers, hosting, or agent infrastructure." | The ONLY crypto/trading mention in index.html — E3's trigger. meta description, OG, Twitter card are already neutral. |

---

## Excluded (unchanged)

- Venue display names from the backend provider catalog (not static UI copy).
- `capabilityMode`, execution-mode enum identifiers, type/variable names.
- `apps/web/src/features/public-pages/content/**` (moved to Traderton, T3.2).
- Test files.
