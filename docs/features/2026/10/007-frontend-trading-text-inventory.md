# Frontend Crypto/Trading Text Inventory (E3 deliverable)

**Date:** 2026-10-01. **Status:** inventory only — **producing this table is the
task; APPLYING it (relabeling the copy) is a LATER task** (operator decision
P2-19, E3 resolved "keep as-is for now").
**Scope:** user-facing text in the herobids web frontend only
(`apps/web/src/app/i18n/locales/en.ts`, inline JSX in `apps/web/src/**/*.tsx`
excluding tests and `features/public-pages/**`, and `apps/web/index.html`).
Public-pages markdown is excluded (already moved to Traderton in T3.2).

**Totals:** 171 distinct items — i18n 150 · inline JSX 20 · index.html 1.
Every i18n key has `ar`/`hi` twins (same key); only the English value is shown.

## How to read the "Proposed replacement" column

- A concrete capability-neutral rewrite is given where the text is simple
  product/onboarding copy that can be neutralized in place.
- `—` with "Deferred Phase-3 trading-feature move — N/A" means the text belongs
  to a whole trading FEATURE (bots, exposure, instance detail, technical/strategy
  config, approvals, trade history) whose disposition is decided in Phase 3; a
  replacement is premature until the feature's fate (move/keep/gate) is settled.
- "Neutral; keep" means the text is already capability-neutral and listed only
  because it was trading-adjacent in the sweep.
- "Ambiguous — verify" flags strings that may be fine as-is.

## Notable findings

- **`index.html` is already capability-neutral except ONE phrase** — the JSON-LD
  `about.description` says "…from crypto trading to personal assistance." That
  single phrase is E3's actual trigger; the meta description, OpenGraph, and
  Twitter card copy are already neutral.
- The bulk of trading copy is i18n under `nav.*`, `activity.*`, `missionControl.*`,
  `exposure.*`, `agents.*` (executionMode / capability / controls / approvals /
  trades / technical.* / strategyReview / capabilityPage), `bots.*`,
  `instances.*`, `instanceDetail.*`, `setup.form.*`, `connections.*`, plus a few
  `agents.create.goalPlaceholder.*` onboarding strings.
- Inline (non-i18n) hardcoded trading text concentrates in 6 files:
  `features/setup/WalletCreatedStep.tsx`, `features/setup/ProviderSetupForm.tsx`,
  `features/agents/TradingCapabilityPresentation.tsx`,
  `features/exposure/ExposurePage.tsx`, `features/bots/BotCustomConfigSection.tsx`,
  `features/blueprints/BlueprintInstantiateFlow.tsx`.
- Venue display names (Hyperliquid/Bybit/Jupiter/1inch) are NOT hardcoded UI
  copy — they come from the backend provider catalog — except example text like
  `setup.form.namePlaceholder` ("e.g. My Hyperliquid account") and
  `missionControl.setup.message` ("…like Hyperliquid or Gmail").

---

## I18n strings
`apps/web/src/app/i18n/locales/en.ts` — all have ar/hi twins.

| Location (i18n key) | Current text (verbatim) | Proposed capability-neutral replacement | Notes |
|---|---|---|---|
| nav.bots | Bots | — | Deferred Phase-3 trading-feature move — N/A |
| nav.tradingSetup | Trading setup | Connect a platform | Sidebar nav |
| nav.exposure | Exposure | — | Deferred Phase-3 — N/A |
| activity.noActivity.message | Events will appear here as your AI agents make decisions, place orders, and manage positions. | Events will appear here as your AI agents take actions. | Empty state |
| activity.decision.accepted | Decision accepted: {intent} {instrumentId} | — | Deferred Phase-3 — N/A |
| activity.decision.rejected | Decision rejected: {reason} | — | Deferred Phase-3 — N/A |
| activity.risk.breach | Risk limit breached: {reason} | — | Deferred Phase-3 — N/A |
| activity.risk.guardrail_triggered | Guardrail triggered: {reason} | — | Deferred Phase-3 — N/A |
| activity.order.submitted | Order placed: {side} {symbol} | — | Deferred Phase-3 — N/A |
| activity.order.filled | Order filled: {side} {quantity} {symbol} @ {price} | — | Deferred Phase-3 — N/A |
| activity.order.fill_confirmed_from_stream | Fill confirmed: {side} {quantity} {symbol} | — | Deferred Phase-3 — N/A |
| activity.order.cancelled | Order cancelled | — | Deferred Phase-3 — N/A |
| activity.order.rejected | Order rejected by venue: {reason} | — | Deferred Phase-3 — N/A |
| activity.instance.live_armed | Live trading armed | — | Deferred Phase-3 — N/A |
| activity.instance.live_blocked | Live trading blocked: {reason} | — | Deferred Phase-3 — N/A |
| activity.reconciliation.drift_detected | Position drift detected — reconciling | — | Deferred Phase-3 — N/A |
| activity.live.slippage_alert | High slippage detected: {slippageBps} bps | — | Deferred Phase-3 — N/A |
| missionControl.metric.totalPnl | Total Realized P&L | Total outcome | Ambiguous — verify (dashboard metric) |
| missionControl.setup.message | Connect your AI agents to external platforms like Hyperliquid or Gmail. | Connect your AI agents to external platforms. | Hardcoded venue name in example |
| exposure.title | Exposure | — | Deferred Phase-3 — N/A |
| exposure.subtitle | Current positions and risk concentration | — | Deferred Phase-3 — N/A |
| exposure.totalRealizedPnl | Total Realized P&L | — | Deferred Phase-3 — N/A |
| exposure.openPositions | Open Positions | — | Deferred Phase-3 — N/A |
| exposure.emptyTitle | No open positions | — | Deferred Phase-3 — N/A |
| exposure.emptyMessage | Positions will appear here once your AI agents start trading. | — | Deferred Phase-3 — N/A |
| agents.executionMode.label | Execution mode | — | Operational mechanic; trading-adjacent |
| agents.executionMode.live | Live | — | Deferred Phase-3 — N/A |
| agents.capabilityFamily.trading | Trading | — | Deferred Phase-3 — N/A |
| agents.capabilityState.unconfigured.tradingNote | Paper trading works without this. Connect an external platform to enable live trading. | Connect an external platform to enable this capability. | Capability readiness note |
| agents.capabilityPage.tradingUnavailable | Trading details are unavailable until the selected connection is ready. | Capability details are unavailable until the selected connection is ready. | Capability page |
| agents.summary.pnl | P&L | — | Deferred Phase-3 — N/A |
| agents.summary.tradeCount | {count, plural, one {# trade} other {# trades}} | — | Deferred Phase-3 — N/A |
| agents.summary.winRate | Win: {rate, number}% | — | Deferred Phase-3 — N/A |
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
| agents.detail.fundingBanner.text | Your trading wallet may need funding before live trading. | — | Deferred Phase-3 — N/A |
| agents.detail.tradesHistory | Trade History | — | Deferred Phase-3 — N/A |
| agents.strategyReview.* (runReview, running, notAvailable, completeWithAdvice, adviceColumn.*, assessing, results.*) | Run Strategy Review / Strategy Assessment Results / Active Preset / Agent switched to {preset} … | — | Deferred Phase-3 — N/A (~15 keys) |
| agents.trades.col.* + status/empty (token, venue, entry, exit, size, pnl, hold, mode, statusOpen, statusClosed, empty) | Token / Venue / Entry / Exit / Size / PnL / Hold / Mode / Open / Closed / No trade history yet. | — | Deferred Phase-3 — N/A (~11 keys) |
| agents.capability.hybrid.description | Indicators pre-filter trade options, LLM makes final call. | — | Deferred Phase-3 — N/A |
| agents.technical.* (title, preset.*, filterTrades, platformAssessment.*, filters.*, scan.signalBias.*, indicators.*, params.*) | Technical Configuration / Strategy preset / Momentum Breakout / Mean Reversion / Filter Trades / Periodic Strategy Assessment / Venue / RSI / MACD / CHOCH / Overbought / Oversold / Breakout threshold … | — | Deferred Phase-3 — N/A (~45 trading-specific keys) |
| agents.runtimePolicy.tradingSessionsLabel (+ Help + session.*) | Trading Sessions / Shortcuts for common market windows (Eastern Time)… | — | Deferred Phase-3 — N/A |
| agents.edit.dailyMaxLossPct / maxSlippage / maxBots | Daily loss limit (%) / Max slippage (bps) / Max bots | — | Deferred Phase-3 — N/A |
| agents.edit.intelligenceIgnoredWarning | Switching to Technical-only: the agent's LLM configuration … ignored at runtime … | — | Ambiguous — verify (capability mechanic) |
| plan.live_disabled | Live trading is not enabled on your current plan. | — | Deferred Phase-3 — N/A |
| credential.validation_error.invalid_wallet_address | Enter a valid wallet address for {venue}. | — | Deferred Phase-3 — N/A |
| credential.validation_error.invalid_private_key | Enter a valid private key for {venue}. | — | Deferred Phase-3 — N/A |
| connection.missing_venue_account | No venue account found for this connection. Please complete trading setup first. | — | Deferred Phase-3 — N/A |
| ai_invalid_config | AI response is missing required config sections (strategy, risk, execution). | — | Deferred Phase-3 — N/A |
| config_invalid | Bot config is invalid — cannot start. Fix the config before retrying. | — | Deferred Phase-3 — N/A |
| max_bots_reached | Agent has reached its maximum concurrent bots limit. Stop a bot before starting a new one. | — | Deferred Phase-3 — N/A |
| setup.form.standaloneSubtitle | Connect a trading exchange, email account, or custom integration. Secrets are encrypted and never stored in plain text. | Connect an exchange, email account, or custom integration… | Setup form subtitle |
| setup.form.group.trading | Trading | — | Deferred Phase-3 — N/A |
| setup.form.namePlaceholder | e.g. My Hyperliquid account | e.g. My account | Hardcoded venue name in placeholder |
| connections.cascadeDeleteConfirm | Delete connection "{label}" and its linked wallet record and stored credential/private key from OpenAIdom? … | — | Deferred Phase-3 — N/A (wallet-specific) |
| connections.cascadeDeleteBlocked | Cannot delete the linked wallet data. Remove agent grants and bots first… | — | Deferred Phase-3 — N/A |
| connections.deleteBlockedByBots | Cannot delete this connection because it is referenced by bots: {blockingBotIds}. Delete the bots first. | — | Deferred Phase-3 — N/A |
| connections.fundingAddress | Funding address | — | Deferred Phase-3 — N/A |
| bots.* (title, subtitle, createBot, empty.message, kv.strategy, modal.*) | Bots / Trading bots created by you or your AI agents / Create Bot / Strategy / Symbol (e.g. BTC-PERP) / Strategy style / Execution mode … | — | Deferred Phase-3 — N/A (~18 keys) |
| instances.* / instanceDetail.* (title, subtitle, config.strategy/symbol/executionMode, openPositions, timeline.empty.message, modal.stop/delete.*) | Bots / Advanced trading records kept for compatibility and history / Strategy / Symbol / Open positions / "once the agent starts trading" / "open positions will remain in your portfolio" … | — | Deferred Phase-3 — N/A (~15 keys) |
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
| features/exposure/ExposurePage.tsx:84 | No open positions | — | Deferred Phase-3; hardcoded EN |
| features/exposure/ExposurePage.tsx:109/113/116 | Size / Entry / Realized P&L | — | Deferred Phase-3; hardcoded EN |
| features/bots/BotCustomConfigSection.tsx (section titles) | Strategy / Exit Targets / Position Sizing / Risk Guardrails | — | Deferred Phase-3; hardcoded EN |
| features/bots/BotCustomConfigSection.tsx (field labels) | Strategy type / Signal bias / Candle interval / Candle limit / Stop loss % / Take profit % / Trailing stop % / Position size / Size mode / Max position size % / Max open positions / Daily loss limit % / Max unrealized loss % | — | Deferred Phase-3; hardcoded EN (~13 labels) |
| features/bots/BotCustomConfigSection.tsx (options) | Momentum / Range / Contrarian / Swing / Scalper / Trend-following / Mean-reverting / % of equity / Fixed | — | Deferred Phase-3; hardcoded EN |
| features/blueprints/BlueprintInstantiateFlow.tsx | Strategy / Risk Profile / Risk overrides / Trading connections / "Select active connections for this agent to trade through." / "No trading connections selected…" / Max open positions / Max position size % / Stop loss % / Max drawdown % / Daily max loss % | — | Deferred Phase-3 — N/A; hardcoded EN |

## index.html SEO/OG/JSON-LD
`apps/web/index.html`

| Location | Current text (verbatim) | Proposed capability-neutral replacement | Notes |
|---|---|---|---|
| JSON-LD `about.description` | "…an autonomous agent gets it done for you — from crypto trading to personal assistance. Create your own personal assistant without managing servers, hosting, or agent infrastructure." | "…an autonomous agent gets it done for you. Create your own personal assistant without managing servers, hosting, or agent infrastructure." | The ONLY crypto/trading mention in index.html — E3's trigger. meta description, OG, Twitter card are already neutral. |

---

## Exclusions (for completeness)

- Venue display names from the backend provider catalog (not static UI copy).
- `capabilityMode`, execution-mode enum identifiers, type/variable names.
- `apps/web/src/features/public-pages/content/**` (moved to Traderton, T3.2).
- Test files.
