# Orphan i18n Key Sweep — tracking ledger

**Created:** 2026-10-02. **Status:** living document — expect multiple passes.
**Companion to:** [`007-frontend-trading-text-inventory.md`](./002-frontend-trading-text-inventory.md)
(the trading-text inventory). This doc tracks the broader **dead i18n key**
cleanup in `apps/web/src/app/i18n/locales/{en,ar,hi}.ts`.

## Why this doc exists

A full-literal sweep of the web i18n catalog flags many keys with no literal
reference, but a literal "no match" does **not** prove a key is dead — the
frontend resolves many keys dynamically. Deleting blindly would break the UI or
error localization. Removing dead keys safely therefore takes several careful
passes, and we need a durable record of each key's disposition so passes don't
re-litigate one another. That record is this document.

## How a key can still be "live" despite no literal reference

1. **Backend error codes.** `lib/localize-api-error.ts` resolves messages via
   `intl.formatMessage({ id: error.code })`, and `api-client.ts` sets
   `ApiError.code = body.error`. So any i18n key equal to (or namespaced under)
   an error code the API/engine/worker/boundary can emit is reached at runtime.
   There is **no canonical error-code registry** — the set below was
   reconstructed from code (`reply.send({ error: '…' })`, `err('…')`, `code: '…'`
   across `apps/api/src`, `packages/*`, `apps/worker/src`).
2. **Template-literal keys.** e.g. `` `agents.executionMode.${mode}` ``,
   `` `status.${status}` ``, `` `billing.interval.${interval}` ``.
3. **Test references.** A key used only by a `*.test.ts(x)` file.

## Method (per pass)

A candidate = a catalog key with (a) no literal reference anywhere in
`apps/web/src` (incl. tests) AND (b) not reachable by any detected
template-literal prefix. Candidates are then gated:

- **KEEP (B1)** if the key equals / is an ancestor of / is a descendant of an
  emitted error code.
- **KEEP (B2)** if it is error-code-shaped by pattern (bare `snake_case`,
  `*.validation_error.*`, `*_failed`/`*_mismatch`/`*_required`/… suffixes, error
  fragments, or whole `auth.*`/`billing.*`/`credential.*`/`connection.*`/
  `account.*`/`plan.*` namespaces). Held for a later per-key pass.
- **KEEP (C)** if dynamically reachable (template-literal prefix).
- **DELETE (A)** only if it passes all gates **and** is hand-verified: no
  literal ref (incl. tests), no dynamic construction, not an error code. Each
  risky cluster was individually inspected (see Pass A notes).

Every removed key is deleted from **all three** locales (`en`/`ar`/`hi`) to keep
`catalog-consistency.test.ts` green.

## Pass log

### Pass A — 2026-10-02 — DELETED 103 keys
Conservative dead-UI-chrome removal. Candidate pool 177 → excluded 15 (B1
error-code) + 59 (B2 error-shaped) → **103 deleted**. Hand-verified clusters:
`agents.evaluations.status.*`, `agents.technical.preset.*`, `agents.trades.col.*`,
`agents.create.goalPlaceholder` (+`.personalAssistant`; `resolveGoalPlaceholderKey`
only ever returns `.trading`/`.custom`), `missionControl.*` (note:
`missionControl.metric.{active,paused,unhealthy,stopped}` are LIVE in
`AgentsPage` and were NOT candidates; only `missionControl.metric.totalPnl` and
the page-chrome keys were dead), `public.notAvailableInLanguage`/`viewInEnglish`,
`agents.summary.{pnl,tradeCount,winRate,openAgent,checkingCapability}` (the live
`agents.summary.*` keys are a different set). Verified: `pnpm lint`, web build,
and the full web vitest suite green after removal.

### Pass 009 — 2026-10-02 — DELETED 4 keys (via change 009, Part B3)
Change [`009-skill-first-agent-creation`](./004-skill-first-agent-creation/001-plan.md)
removed the create form's "Suggested skills" dropdown (a disguised type selector)
and its dead code. The following keys were deleted from all three locales
(`en`/`ar`/`hi`) in the same change: `agents.create.suggestedSkills`,
`agents.create.suggestedSkills.custom`, `agents.create.suggestedSkills.trading`,
`agents.create.suggestedSkills.personalAssistant`. See the "Removed by change
009" table below.

### Pass B — PENDING (classification only; NO deletion)
Sections B1 and B2 below are the Pass-B review surface. B1 is confirmed-live
(matches emitted error codes). B2 needs per-key confirmation: for each, check
whether the exact code is actually emitted by the API/engine/worker/boundary; if
a B2 key turns out NOT to be an emitted code and is not otherwise referenced, it
becomes a future delete candidate. **Do not delete B2 in a sweep** — several B2
entries are plainly live UI labels caught by the conservative pattern (e.g.
`auth.login.submit`, `billing.manageBilling`, `auth.email.name.label`).

---

## Ledger

Status legend: **DELETED (A)** removed in Pass A · **KEEP (B1)** emitted error
code · **KEEP (B2)** error-shaped, Pass-B review · **KEEP (C)** dynamic.

### A — DELETED in Pass A (103)

| Key | English value | Status |
|---|---|---|
| `agents.advanced.skills` | Skills | DELETED (A) |
| `agents.approvals.confidence` | Confidence | DELETED (A) |
| `agents.approvals.instrument` | Instrument | DELETED (A) |
| `agents.approvals.intent` | Intent | DELETED (A) |
| `agents.approvals.limitPrice` | Limit Price | DELETED (A) |
| `agents.approvals.market` | Market | DELETED (A) |
| `agents.approvals.noRationale` | No rationale provided. | DELETED (A) |
| `agents.approvals.orderType` | Order type | DELETED (A) |
| `agents.approvals.rationale` | Rationale | DELETED (A) |
| `agents.approvals.stopLoss` | Stop Loss | DELETED (A) |
| `agents.approvals.takeProfit` | Take Profit | DELETED (A) |
| `agents.approvals.targetSize` | Target Size | DELETED (A) |
| `agents.authorizationMode.display.approvalRequired` | Approval required | DELETED (A) |
| `agents.authorizationMode.display.direct` | Direct | DELETED (A) |
| `agents.capabilityPage.bindDisabledTooltip` | Connection is not active | DELETED (A) |
| `agents.controls.dailyTokenBudget` | Daily LLM token budget | DELETED (A) |
| `agents.create.capabilitySetupTitle` | {capability} capability setup | DELETED (A) |
| `agents.create.goalPlaceholder` | e.g. Grow this portfolio aggressively | DELETED (A) |
| `agents.create.goalPlaceholder.personalAssistant` | e.g. Remind me next week Tuesday to wish Jane a happy birthday | DELETED (A) |
| `agents.create.technicalPreFilter.help` | Reduce cost by filtering trade options before AI agent sees them. | DELETED (A) |
| `agents.create.whereToTrade` | Connect agent to external platform | DELETED (A) |
| `agents.detail.noActivity` | No activity recorded yet. | DELETED (A) |
| `agents.detail.noDecisions` | No decisions submitted yet. | DELETED (A) |
| `agents.detail.noProtocolActivity` | No protocol messages yet. | DELETED (A) |
| `agents.detail.protocolActivity` | Protocol activity | DELETED (A) |
| `agents.detail.recentDecisions` | Recent decisions | DELETED (A) |
| `agents.detail.systemPrompt` | System prompt | DELETED (A) |
| `agents.detail.tradesHistory` | Trade History | DELETED (A) |
| `agents.edit.dailyMaxLossPct` | Daily loss limit (%) | DELETED (A) |
| `agents.edit.dailyTokenBudget` | Daily token budget | DELETED (A) |
| `agents.edit.intelligenceIgnoredWarning` | Switching to Technical-only: the agent's LLM configuration (goal, skills, model) will be ignored at runtime but is not deleted. Switch back to Intelligence or Both to re-enable it. | DELETED (A) |
| `agents.edit.maxBots` | Max bots | DELETED (A) |
| `agents.edit.maxSlippage` | Max slippage (bps) | DELETED (A) |
| `agents.edit.name` | Name | DELETED (A) |
| `agents.edit.selectedSkills` | Selected skills | DELETED (A) |
| `agents.edit.telegramChatId` | Telegram chat ID | DELETED (A) |
| `agents.evaluations.completedAt` | Completed | DELETED (A) |
| `agents.evaluations.retry` | Retry | DELETED (A) |
| `agents.evaluations.sectionScore` | {section} score | DELETED (A) |
| `agents.evaluations.status.failed` | Failed | DELETED (A) |
| `agents.evaluations.status.queued` | Queued | DELETED (A) |
| `agents.evaluations.status.running` | Running | DELETED (A) |
| `agents.evaluations.status.succeeded` | Succeeded | DELETED (A) |
| `agents.evaluations.status.timed_out` | Timed Out | DELETED (A) |
| `agents.evaluations.trigger` | Trigger | DELETED (A) |
| `agents.modeBadge` | {mode} mode | DELETED (A) |
| `agents.strategyReview.adviceColumn.rank` | Rank | DELETED (A) |
| `agents.summary.checkingCapability` | Checking capability readiness… | DELETED (A) |
| `agents.summary.openAgent` | Open AI agent | DELETED (A) |
| `agents.summary.pnl` | P&L | DELETED (A) |
| `agents.summary.tradeCount` | {count, plural, one {# trade} other {# trades}} | DELETED (A) |
| `agents.summary.winRate` | Win: {rate, number}% | DELETED (A) |
| `agents.technical.filters.venueType` | Venue type | DELETED (A) |
| `agents.technical.filters.venueTypeAuto` | auto | DELETED (A) |
| `agents.technical.preset.conservative.description` | High confidence threshold, slower scan, fewer entries | DELETED (A) |
| `agents.technical.preset.conservative.label` | Conservative | DELETED (A) |
| `agents.technical.preset.custom.description` | Configure indicators manually | DELETED (A) |
| `agents.technical.preset.custom.label` | Custom | DELETED (A) |
| `agents.technical.preset.meanReversion.description` | Buy oversold dips, CHOCH reversals | DELETED (A) |
| `agents.technical.preset.meanReversion.label` | Mean Reversion | DELETED (A) |
| `agents.technical.preset.momentumBreakout.description` | Trend-following: RSI health, MACD crossover, volume confirmation | DELETED (A) |
| `agents.technical.preset.momentumBreakout.label` | Momentum Breakout | DELETED (A) |
| `agents.trades.col.entry` | Entry | DELETED (A) |
| `agents.trades.col.exit` | Exit | DELETED (A) |
| `agents.trades.col.hold` | Hold | DELETED (A) |
| `agents.trades.col.mode` | Mode | DELETED (A) |
| `agents.trades.col.pnl` | PnL | DELETED (A) |
| `agents.trades.col.size` | Size | DELETED (A) |
| `agents.trades.col.status` | Status | DELETED (A) |
| `agents.trades.col.time` | Time | DELETED (A) |
| `agents.trades.col.token` | Token | DELETED (A) |
| `agents.trades.col.venue` | Venue | DELETED (A) |
| `agents.trades.empty` | No trade history yet. | DELETED (A) |
| `agents.trades.statusClosed` | Closed | DELETED (A) |
| `agents.trades.statusOpen` | Open | DELETED (A) |
| `connections.usedBy` | Used by: {agents} | DELETED (A) |
| `connections.usedByNone` | Not assigned to any agents | DELETED (A) |
| `guidedSetup.billingGate.checking` | Checking account… | DELETED (A) |
| `guidedSetup.billingGate.hardLimited` | You've reached your usage limit. Add credit to continue using Guided Setup. | DELETED (A) |
| `guidedSetup.billingGate.suspended` | Your account is suspended. Please contact support. | DELETED (A) |
| `missionControl.createAgent` | Create AI agent | DELETED (A) |
| `missionControl.metric.totalPnl` | Total Realized P&L | DELETED (A) |
| `missionControl.noActivityYet.message` | Events appear here once AI agents start taking actions. | DELETED (A) |
| `missionControl.noActivityYet.title` | No activity yet | DELETED (A) |
| `missionControl.noAgents.message` | Create an AI agent from a goal, then attach capabilities only when you need them. | DELETED (A) |
| `missionControl.noAgents.title` | No AI agents yet | DELETED (A) |
| `missionControl.section.agents` | Your AI agents | DELETED (A) |
| `missionControl.section.recentActivity` | Recent activity | DELETED (A) |
| `missionControl.setup.cta` | Connect AI agent | DELETED (A) |
| `missionControl.setup.message` | Connect your AI agents to external platforms like Hyperliquid or Gmail. | DELETED (A) |
| `missionControl.setup.successDismiss` | Done | DELETED (A) |
| `missionControl.setup.successMessage` | {label} ({provider}) is ready for your AI agents. | DELETED (A) |
| `missionControl.setup.title` | Connect AI agent to external platform | DELETED (A) |
| `missionControl.subtitle` | {activeCount, plural, one {# active AI agent} other {# active AI agents}} across {totalCount} total | DELETED (A) |
| `missionControl.title` | Mission Control | DELETED (A) |
| `missionControl.viewAllActivity` | View all activity → | DELETED (A) |
| `nav.createAgent` | New AI Agent | DELETED (A) |
| `public.notAvailableInLanguage` | This page is not available in your language. | DELETED (A) |
| `public.viewInEnglish` | View in English | DELETED (A) |
| `skills.adminUnavailable` | Admin scope unavailable for this account. | DELETED (A) |
| `skills.empty.admin.message` | The admin skill catalog is currently empty. | DELETED (A) |
| `skills.empty.admin.title` | No admin skills | DELETED (A) |
| `skills.tab.adminCatalog` | Admin catalog | DELETED (A) |

### B1 — KEEP: matches an emitted backend error code (15)

| Key | English value | Relation to error code |
|---|---|---|
| `agent_not_editable` | Agent can only be edited while stopped or crashed. Current status: {status}. | exact |
| `ai_invalid_config` | AI response is missing required config sections (strategy, risk, execution). | exact |
| `ai_parse_error` | AI returned invalid JSON. | exact |
| `credential.validation_error.invalid_private_key` | Enter a valid private key for {venue}. | exact |
| `credential.validation_error.invalid_wallet_address` | Enter a valid wallet address for {venue}. | exact |
| `forbidden` | You do not have permission to perform this action. | exact |
| `invalid_state` | The resource is in an invalid state for this operation. | exact |
| `invalid_target` | The target resource is not valid for this operation. | exact |
| `narrative_llm_resolution_failed` | Narrative AI configuration could not be resolved. | exact |
| `no_ai_provider` | No AI provider is configured on this platform. | exact |
| `no_session_found` | No completed session found for this scope. | exact |
| `plan.limit_exceeded` | Your current plan limit for {resource} is {limit}. | exact |
| `plan.live_disabled` | Live trading is not enabled on your current plan. | exact |
| `plan_limit` | This action is not available on your current plan. | exact |
| `rate_limited` | Rate limit exceeded. Please wait before trying again. | exact |

### B2 — KEEP (Pass B review): error-code-shaped / error namespace (59)

| Key | English value | Why held |
|---|---|---|
| `account.validation_error.invalid_venue_account_ref` | Enter a valid account reference for {venue}. | validation_error |
| `account.validation_error.missing_credential_id` | {field} is required for {venue}. | validation_error |
| `account.validation_error.missing_venue_account_ref` | {field} is required for {venue}. | validation_error |
| `agent_not_stopped` | Stop the agent before deleting it. Current status: {status}. | bare-snake |
| `auth.email.name.label` | Name | error-namespace |
| `auth.email.name.placeholder` | Your name | error-namespace |
| `auth.email.password.placeholder` | At least 8 characters | error-namespace |
| `auth.exchange.missing_code` | Missing exchange code. | error-fragment |
| `auth.google.email_not_verified` | Your Google email address must be verified before signing in. | error-namespace |
| `auth.google.invalid_state` | Your sign-in session expired. Start sign-in again. | error-fragment |
| `auth.google.missing_code` | Missing authorization code. | error-fragment |
| `auth.google.token_exchange_failed` | Could not complete Google sign-in. Try again. | error-suffix |
| `auth.google.userinfo_failed` | Could not load your Google profile. Try again. | error-suffix |
| `auth.login.invalid_credentials` | Invalid email or password. | error-fragment |
| `auth.login.password_not_available` | This account uses email-link or Google sign-in. Use those methods to sign in. | error-namespace |
| `auth.login.required_fields` | Email and password are required. | error-namespace |
| `auth.login.submit` | Sign in | error-namespace |
| `auth.logout.malformed_token` | Malformed token. | error-namespace |
| `auth.logout.missing_authorization` | Missing authorization. | error-fragment |
| `auth.logout.missing_session_id` | Token missing session ID. | error-fragment |
| `auth.pendingSubmit` | Please wait… | error-namespace |
| `auth.profile.invalid_preferred_locale` | Language must be one of: {supportedLocales}. | error-fragment |
| `auth.profile.invalid_telegram_chat_id` | Telegram chat ID must be a string or null. | error-fragment |
| `auth.register.email_taken` | An account with this email already exists. | error-suffix |
| `auth.register.invalid_email` | Enter a valid email address. | error-fragment |
| `auth.register.required_fields` | Email and password are required. | error-namespace |
| `auth.register.submit` | Create account | error-namespace |
| `auth.send_login_link.invalid_username` | Username must be 3–30 characters and may only contain lowercase letters, digits, and underscores. | error-fragment |
| `auth.send_login_link.username_taken` | This username is already taken. | error-suffix |
| `auth.switchToLogin` | Already have an account? Sign in | error-namespace |
| `auth.switchToRegister` | Don't have an account? Sign up | error-namespace |
| `auth.unauthenticated` | You need to sign in first. | error-namespace |
| `auth.user_not_found` | User not found. | error-namespace |
| `billing.cancel.already_canceled` | This subscription is already scheduled to cancel. | error-fragment |
| `billing.cancel.no_active_subscription` | There is no active subscription to cancel. | error-namespace |
| `billing.checkout.invalid_plan_id` | The selected plan is not available for checkout. | error-fragment |
| `billing.checkout.invalid_price_id` | The selected billing price is invalid. | error-fragment |
| `billing.checkout.plan_id_required` | Choose a plan before continuing to checkout. | error-suffix |
| `billing.loadingCheckout` | Loading… | error-namespace |
| `billing.manageBilling` | Manage billing | error-namespace |
| `billing.opening` | Opening… | error-namespace |
| `billing.portal.no_billing_account` | No billing account exists yet for this workspace. | error-namespace |
| `billing.providerLabel` | Provider: {provider} | error-namespace |
| `billing.upgrade.invalid_plan_id` | The selected upgrade plan is not available. | error-fragment |
| `billing.upgrade.invalid_price_id` | The selected upgrade price is invalid. | error-fragment |
| `billing.upgrade.missing_provider_mapping` | The selected plan is missing its billing provider mapping. | error-fragment |
| `billing.upgrade.no_active_subscription` | You need an active subscription before changing plans. | error-namespace |
| `billing.upgrade.plan_id_required` | Choose a plan before changing subscription tiers. | error-suffix |
| `billing.upgrade.subscription_not_upgradeable` | The current subscription cannot be changed automatically. | error-namespace |
| `billing.usage.totalCredit` | Total credit | error-namespace |
| `billing.user_not_found` | Billing account could not be loaded for the current user. | error-namespace |
| `config_invalid` | Bot config is invalid — cannot start. Fix the config before retrying. | bare-snake |
| `connection.missing_venue_account` | No venue account found for this connection. Please complete trading setup first. | error-fragment |
| `credential.not_found` | Credential {credentialId} does not exist. | error-fragment |
| `credential.provider_mismatch` | Credential provider {credentialProvider} does not match {provider}. | error-suffix |
| `credential.venue_mismatch` | Credential venue does not match the connection provider. | error-suffix |
| `max_bots_reached` | Agent has reached its maximum concurrent bots limit. Stop a bot before starting a new one. | bare-snake |
| `not_paused` | Agent must be paused before it can resume. Current status: {status}. | bare-snake |
| `not_stopped` | Agent must be stopped before it can start. Current status: {status}. | bare-snake |

### C — KEEP: dynamically reachable (template-literal prefix) (39)

| Key | English value |
|---|---|
| `agents.capability.technical.cost` | No LLM cost |
| `agents.capability.technical.description` | Rule-based indicator scanning. No LLM. |
| `agents.capability.technical.label` | Technical |
| `agents.capabilityFamily.trading` | Trading |
| `agents.eligibility.eligible` | Eligible |
| `agents.eligibility.ineligible` | Ineligible |
| `agents.executionMode.live` | Live |
| `agents.executionMode.paper` | Test |
| `agents.executionMode.shadow` | Test |
| `agents.executionMode.test` | Test |
| `agents.runtimePolicy.deepThinkingTokens` | Premium thinking tokens |
| `agents.runtimePolicy.judgeMaxTokens` | Judge max output tokens |
| `agents.runtimePolicy.judgeMaxTurns` | Judge max turns |
| `agents.runtimePolicy.judgeMaxTurnsHelp` | Maximum tool call turns per judge loop. |
| `agents.runtimePolicy.lightThinkingTokens` | Economy thinking tokens |
| `agents.runtimePolicy.maxContextBlockChars` | Max context block chars |
| `agents.runtimePolicy.maxHistoryMessages` | Max history messages |
| `agents.runtimePolicy.maxHistoryTokens` | Max history tokens |
| `agents.runtimePolicy.maxHoldDurationMs` | Max hold duration (min) |
| `agents.runtimePolicy.maxRecentToolMessages` | Max recent tool messages |
| `agents.runtimePolicy.maxToolResultChars` | Max tool result chars |
| `agents.runtimePolicy.maxVisibleToolSchemas` | Max visible tool schemas |
| `agents.runtimePolicy.scoutMaxTokens` | Scout max output tokens |
| `agents.runtimePolicy.scoutMaxTurns` | Scout max turns |
| `agents.runtimePolicy.scoutMaxTurnsHelp` | Maximum tool call turns per scout loop. |
| `agents.runtimePolicy.toolResultFullRetentionTurns` | Full retention turns |
| `agents.runtimePolicy.toolResultMaxStaleChars` | Max stale tool result chars |
| `agents.style.summaryPrefix` | This style gives you: |
| `agents.technical.scan.signalBias.meanReverting` | Mean-reverting |
| `agents.technical.scan.signalBias.trendFollowing` | Trend-following |
| `billing.interval.month` | month |
| `billing.interval.year` | year |
| `status.active` | active |
| `status.crashed` | crashed |
| `status.paused` | paused |
| `status.running` | running |
| `status.starting` | starting |
| `status.stopped` | stopped |
| `status.unhealthy` | unhealthy |

### Removed by change 009 (Part B3) — Suggested-skills dropdown (4)

Deleted from all three locales (`en`/`ar`/`hi`) by
[`009-skill-first-agent-creation`](./004-skill-first-agent-creation/001-plan.md)
when the create form's "Suggested skills" dropdown and its dead code
(`SuggestedSkillSetId`, `SUGGESTED_SKILL_SETS`, `resolveSuggestedSkillIds`,
`IntentState.suggestedSkills`) were removed.

| Key | English value | Status |
|---|---|---|
| `agents.create.suggestedSkills` | Suggested skills | DELETED (009) |
| `agents.create.suggestedSkills.custom` | Choose skills manually | DELETED (009) |
| `agents.create.suggestedSkills.trading` | Trading starter | DELETED (009) |
| `agents.create.suggestedSkills.personalAssistant` | Personal assistant starter | DELETED (009) |
