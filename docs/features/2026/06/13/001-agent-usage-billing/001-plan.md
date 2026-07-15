# Agent Usage Billing

## Objective

Add usage-aware billing to OpenAIdom without replacing the current subscription and entitlement system.

The architectural rule for this feature is:

- OpenAIdom is the source of truth for usage metering, rating, spend-state enforcement, and credit balances.
- Stripe and Creem remain payment rails for subscriptions, checkout, portal access, and top-up collection.
- `plans.*` remains the packaging and coarse entitlement model for feature access, agent counts, and enterprise gating.
- The trading engine, strategy packages, and venue adapters remain billing-agnostic.

This work should turn the current subscription-first billing slice into a hybrid model:

- plan subscription or free tier
- included monthly usage credits
- hard and soft spend caps
- optional credit top-ups
- billable usage for LLM tokens and active agent runtime

## Scope Decisions

These choices should be treated as the default implementation bias unless product decisions override them explicitly.

1. Launch with a hybrid commercial model, not open-ended postpaid.
2. The first billable meters are:
   - `llm.input_tokens`
   - `llm.output_tokens`
   - `llm.reasoning_tokens`
   - `agent.runtime_ms`
3. Billing remains user-owned in the product, but the new schema should introduce an internal `accountId` now so team or workspace billing can be added later without another data-model rewrite.
4. Worker processes should write metering data directly through `packages/db` repositories in v1. Do not add an internal HTTP ingestion API unless this becomes necessary later.
5. Usage charges must be computed from OpenAIdom-side rate cards, not reconstructed from provider invoices.
6. Current worker guardrails such as `dailySpendBudgetUsd` and `dailyTokenBudget` are advisory runtime settings, not authoritative billing controls. Hard billing enforcement must be separate.
7. The existing `GET /billing/ledger` route is already used for trading fill history. Do not overload that route for commercial usage billing.

## Current State Summary

The repo already has the outer control-plane pieces needed for a hybrid billing system:

- payment provider abstraction and checkout flows in `apps/api/src/billing/*`
- authenticated billing routes and summary UI in `apps/api/src/routes/billing.ts` and `apps/web/src/features/billing/BillingPage.tsx`
- subscription persistence in `packages/db/src/schema/billing-customers.ts`, `billing-subscriptions.ts`, and `billing-webhook-events.ts`
- plan entitlement and quota enforcement in `apps/api/src/plugins/auth.ts` and `apps/api/src/plan-guards.ts`
- runtime cost telemetry in `apps/worker/src/agent.ts` and `apps/worker/src/runtime-composition.ts`
- LLM usage exposure in `packages/llm/src/llm-provider.ts`
- runtime session identity in `packages/db/src/schema/agent-runtime-sessions.ts`

The missing layer is durable commercial metering and spend-state enforcement.

## Implementation Boundary

Keep these concerns split cleanly:

1. `plans.*`
   - feature access
   - agent and bot limits
   - live-trading entitlement
   - enterprise-only features

2. `billing.*`
   - subscription checkout
   - customer portal
   - provider webhooks
   - plan-to-price or plan-to-product mapping

3. new usage-billing layer
   - billing account state
   - raw usage events
   - rate cards
   - current billing period totals
   - credit and charge ledger
   - hard and soft spend enforcement

Do not overload `users.planId`, `user_plans`, or `billing_subscriptions` with usage accounting.

## Config Changes

Primary files:

- `packages/domain/src/config/schema.ts`
- `packages/domain/src/config/index.ts`
- `config/default.yaml`

### 1. Extend `plans.*` with usage packaging fields

Add a nested `usage` object to each plan definition so plan packaging can include credits and caps without turning plans into the ledger.

Suggested shape:

- `includedCreditCents: number`
- `softCapCents?: number`
- `hardCapCents?: number`
- `topUpsEnabled: boolean`
- `topUpPackIds: string[]`

Notes:

- Keep plan config human-friendly in cents.
- Convert to finer-grained DB units during rating.
- `enterprise` can set higher caps or omit them entirely through config.

### 2. Add `usageBilling` operator config

Suggested fields:

- `enabled: boolean`
- `defaultCurrency: string` default `USD`
- `runtimeChargeWindowMs: number` default `60000`
- `warningThresholdsPct: number[]` default `[50, 80, 100]`
- `defaultRateCardName: string`
- `creditTopUpsEnabled: boolean`
- `topUpProductsByProvider: Record<string, Array<{ packId: string; externalId: string; cents: number }>>`

Notes:

- Keep provider top-up product mapping in operator config, similar to current plan-to-price mapping.
- Keep rate-card contents in the database for versioning and auditability.

## Schema Proposal

Primary files:

- new `packages/db/src/schema/billing-accounts.ts`
- new `packages/db/src/schema/billing-usage-events.ts`
- new `packages/db/src/schema/billing-rate-cards.ts`
- new `packages/db/src/schema/billing-rate-card-items.ts`
- new `packages/db/src/schema/billing-periods.ts`
- new `packages/db/src/schema/billing-ledger-entries.ts`
- optional later `packages/db/src/schema/billing-usage-daily-rollups.ts`
- `packages/db/src/schema/index.ts`
- `packages/db/src/index.ts`
- `packages/db/drizzle/` new migration

### `billing_accounts`

Purpose: internal commercial-billing owner for usage, credits, and spend-state enforcement.

Suggested columns:

- `id` text PK
- `ownerUserId` text not null references `users.id`, unique
- `status` text not null default `active`
  - `active | soft_limited | hard_limited | suspended`
- `currency` text not null default `USD`
- `activePlanId` text not null
- `softCapMicrousd` bigint nullable
- `hardCapMicrousd` bigint nullable
- `lastEvaluatedAt` timestamptz nullable
- `createdAt` timestamptz not null default now
- `updatedAt` timestamptz not null default now

Indexes:

- unique on `ownerUserId`
- index on `status`

Notes:

- One row per user in v1.
- The table introduces `accountId` now so a future team or workspace owner can replace `ownerUserId` without rewriting all downstream billing tables.

### `billing_usage_events`

Purpose: immutable, raw commercial metering events.

Suggested columns:

- `id` text PK
- `accountId` text not null references `billing_accounts.id`
- `userId` text not null references `users.id`
- `agentId` text nullable references `agents.id`
- `sessionId` text nullable references `agent_runtime_sessions.id`
- `skillId` text nullable
- `sourceType` text not null
  - `llm_call | agent_runtime | manual_adjustment`
- `meterKey` text not null
  - `llm.input_tokens | llm.output_tokens | llm.reasoning_tokens | agent.runtime_ms`
- `provider` text nullable
- `model` text nullable
- `quantity` bigint not null
- `unit` text not null
  - `tokens | milliseconds`
- `idempotencyKey` text not null
- `occurredAt` timestamptz not null
- `metadata` jsonb nullable
- `createdAt` timestamptz not null default now

Indexes:

- unique on `idempotencyKey`
- index on `accountId, occurredAt`
- index on `agentId, occurredAt`
- index on `sessionId`
- index on `meterKey, occurredAt`

Notes:

- This is the authoritative usage record.
- Never update quantity after insert.
- Corrections should be represented as new offsetting events or ledger adjustments, not row mutation.

### `billing_rate_cards`

Purpose: versioned pricing container.

Suggested columns:

- `id` text PK
- `name` text not null
- `version` integer not null
- `currency` text not null default `USD`
- `status` text not null default `draft`
  - `draft | active | retired`
- `effectiveFrom` timestamptz not null
- `effectiveTo` timestamptz nullable
- `createdAt` timestamptz not null default now

Indexes:

- unique on `name, version`
- index on `status, effectiveFrom`

### `billing_rate_card_items`

Purpose: map a billable meter to a unit price.

Suggested columns:

- `id` text PK
- `rateCardId` text not null references `billing_rate_cards.id`
- `meterKey` text not null
- `provider` text nullable
- `modelPattern` text nullable
- `priceMicrousd` bigint not null
- `perUnit` bigint not null
- `roundingMode` text not null default `up`
- `minimumChargeMicrousd` bigint nullable
- `metadata` jsonb nullable
- `createdAt` timestamptz not null default now

Indexes:

- index on `rateCardId, meterKey`

Notes:

- `modelPattern` allows different token rates for different models without hard-coding them in worker code.
- `perUnit` supports pricing like “$X per 1K tokens”.

### `billing_periods`

Purpose: current and historical billing-cycle totals per account.

Suggested columns:

- `id` text PK
- `accountId` text not null references `billing_accounts.id`
- `planIdSnapshot` text not null
- `rateCardId` text not null references `billing_rate_cards.id`
- `periodStart` timestamptz not null
- `periodEnd` timestamptz not null
- `includedCreditMicrousd` bigint not null default `0`
- `softCapMicrousd` bigint nullable
- `hardCapMicrousd` bigint nullable
- `usageChargeMicrousd` bigint not null default `0`
- `creditAppliedMicrousd` bigint not null default `0`
- `reservedMicrousd` bigint not null default `0`
- `balanceMicrousd` bigint not null default `0`
- `status` text not null default `open`
  - `open | closing | closed`
- `externalInvoiceId` text nullable
- `createdAt` timestamptz not null default now
- `updatedAt` timestamptz not null default now

Indexes:

- unique on `accountId, periodStart, periodEnd`
- index on `accountId, status`

Notes:

- This table is the fast read model for summary screens and enforcement.
- `balanceMicrousd` should represent net spend after included credits and adjustments.

### `billing_ledger_entries`

Purpose: append-only financial ledger for credits and debits.

Suggested columns:

- `id` text PK
- `accountId` text not null references `billing_accounts.id`
- `periodId` text nullable references `billing_periods.id`
- `entryType` text not null
  - `included_credit | top_up_credit | usage_charge | manual_adjustment | reversal | reservation | reservation_release | invoice_settlement`
- `direction` text not null
  - `credit | debit`
- `amountMicrousd` bigint not null
- `currency` text not null default `USD`
- `sourceType` text not null
  - `plan | top_up_checkout | usage_event | operator | invoice`
- `sourceId` text nullable
- `description` text nullable
- `metadata` jsonb nullable
- `createdAt` timestamptz not null default now

Indexes:

- index on `accountId, createdAt`
- index on `periodId`
- index on `entryType`
- unique composite on `sourceType, sourceId, entryType` when a deterministic source exists

Notes:

- Use `microusd` precision in the ledger so per-call pricing does not lose cents through rounding.
- UI can convert and round for display.

### Optional later: `billing_usage_daily_rollups`

Purpose: reporting acceleration only.

Do not include this in the first migration unless usage-event volume proves high enough to justify it.

## Repository Layer

Primary files:

- new `packages/db/src/usage-billing-repository.ts`
- `packages/db/src/index.ts`

Add one dedicated repository rather than scattering billing-period and ledger writes across route and worker code.

Suggested methods:

- `getOrCreateBillingAccountForUser(userId)`
- `getSpendState(accountId)`
- `getOrCreateOpenPeriod(accountId, now)`
- `recordUsageEvents(input)`
- `rateUsageEvents(input)`
- `applyIncludedCredit(periodId, amountMicrousd)`
- `applyLedgerEntry(input)`
- `setSpendCaps(accountId, caps)`
- `getUsageSummary(accountId, filters)`
- `getUsageBreakdown(accountId, groupBy, filters)`
- `listUsageEvents(accountId, filters)`
- `openTopUpCreditFromWebhook(input)`

Transaction rule:

- Insert raw usage events.
- Resolve current billing period.
- Resolve applicable rate-card items.
- Insert ledger debit entries.
- Update current period totals.
- Recompute account spend state.

All of that should happen in one transaction for each usage batch so enforcement remains near-real-time.

## Worker Changes

Primary files:

- `packages/llm/src/llm-provider.ts`
- `apps/worker/src/agent.ts`
- `apps/worker/src/agents/agent-session-manager.ts`
- optional new `apps/worker/src/usage-billing-service.ts`
- `apps/worker/src/runtime-composition.ts`

### 1. Expand LLM usage shape

Current provider results expose `tokensUsed` and `thinkingTokens`, but the first billing slice should preserve separate input and output token counts when providers return them.

Add to the LLM result shape:

- `inputTokens?: number`
- `outputTokens?: number`
- `thinkingTokens?: number`
- `tokensUsed: number`

Provider mapping:

- OpenAI path already has `total_tokens` and reasoning token detail. Add input and output extraction where available.
- Anthropic path already exposes `input_tokens`, `output_tokens`, and `thinking_tokens`.
- When a provider only exposes total tokens, store `llm.total_tokens` in metadata and rate using the closest supported meter until a richer response is available.

### 2. Record LLM usage as billing events

In `apps/worker/src/agent.ts`, hook into the existing `onAssistantTurn` callbacks for scout and judge turns.

For each successful provider response:

- build one or more `billing_usage_events`
- include `userId`, `agentId`, `sessionId`, `skillId`, `provider`, `model`, and `occurredAt`
- use deterministic idempotency keys built from `sessionId`, phase, turn count, and provider response identity when available

Suggested event shape per call:

- one `llm.input_tokens` event when input count is known
- one `llm.output_tokens` event when output count is known
- one `llm.reasoning_tokens` event when reasoning count is known and billable
- if only total is known, one `llm.output_tokens` or `llm.total_tokens` fallback event with metadata marking the degraded granularity

### 3. Record runtime usage in coarse windows

Do not write one row per heartbeat.

Instead:

- meter runtime in fixed windows such as `usageBilling.runtimeChargeWindowMs`
- on each healthy heartbeat or reconcile tick, flush one `agent.runtime_ms` event for the elapsed billable window
- close the final partial window on session stop, crash, or forced suspension

Good integration points:

- `AgentSessionManager.handleHeartbeat`
- `AgentSessionManager.stopSession`
- unhealthy or crash paths in the session manager and runtime launcher lifecycle

### 4. Keep billing logic out of `packages/engine`

The engine should remain unaware of commercial billing.

All metering hooks should live in:

- worker orchestration code
- session lifecycle management
- LLM provider boundary

### 5. Keep prompt summaries but change the source of truth later

`runtime-composition.ts` should continue to show estimated session cost and performance summaries in the prompt for operational reasoning.

After usage billing lands, update that summary to prefer persisted charged values when available, while keeping the prompt-facing summary separate from the commercial ledger.

## Enforcement Changes

Primary files:

- `apps/worker/src/agents/agent-session-manager.ts`
- `apps/worker/src/agent.ts`
- optional new `apps/worker/src/usage-billing-guard.ts`
- `apps/api/src/plugins/auth.ts`
- `apps/api/src/plan-guards.ts`

### 1. Session-start enforcement

Before launching a new runtime session:

- resolve the user billing account
- load current spend state
- block session launch if account status is `hard_limited` or `suspended`

Behavior:

- update agent status to a user-visible blocked state or leave stopped with a billing-specific error
- emit an activity event explaining the limit reached

### 2. Pre-LLM-call enforcement

Before dispatching scout or judge LLM calls:

- check current spend state
- if `soft_limited`, allow only if configured to continue or degrade to cheaper models
- if `hard_limited`, skip dispatch and stop or pause the session

This should be enforced in worker orchestration, not in strategy code.

### 3. Distinguish runtime budgets from commercial limits

- `dailySpendBudgetUsd` remains a user-configured runtime preference that can influence cadence.
- usage billing spend caps are account-level commercial controls.

Do not conflate the two in API or UI copy.

### 4. API entitlement responses

Expose billing limit state separately from ordinary plan quota failures.

Examples:

- `billing.limit_exceeded`
- `billing.account_suspended`
- `billing.top_up_required`

Do not return generic `plan.limit_exceeded` for usage-billing failures.

## Billing API Changes

Primary files:

- `apps/api/src/routes/billing.ts`
- `apps/api/src/billing/provider-port.ts`
- `apps/api/src/billing/provider-manager.ts`
- `apps/api/src/billing/stripe-provider.ts`
- `apps/api/src/billing/creem-provider.ts`
- `apps/api/src/billing/mock-provider.ts`
- `apps/api/src/schemas.ts`

### Naming change

The current `GET /billing/ledger` route is actually a trading fill ledger. It should move out of the billing namespace.

Preferred replacements:

- `GET /trading/fills`
- or `GET /trading/ledger`

Do this before adding commercial usage-ledger endpoints.

### New read endpoints

1. `GET /billing/usage-summary`

Suggested response:

- `accountId`
- `planId`
- `accountStatus`
- `currentPeriod`
  - `start`
  - `end`
  - `includedCreditUsd`
  - `usageChargeUsd`
  - `creditAppliedUsd`
  - `balanceUsd`
  - `softCapUsd`
  - `hardCapUsd`
- `warnings`
- `topUpsEnabled`

2. `GET /billing/usage-events`

Query params:

- `limit`
- `offset`
- `agentId`
- `sessionId`
- `meterKey`
- `from`
- `to`

Response:

- paginated raw or lightly-shaped metering events for audit views

3. `GET /billing/usage-breakdown`

Query params:

- `groupBy=agent|skill|meter|model|day`
- `from`
- `to`

Response:

- rated totals grouped for charting and budget visibility

4. `GET /billing/periods`

Response:

- current and historical period summaries with invoice or settlement metadata

### New write endpoints

1. `POST /billing/spend-caps`

Purpose:

- allow the user to set or update account-level soft and hard caps within plan-allowed bounds

2. `POST /billing/top-up-checkout-session`

Purpose:

- create a one-time checkout session for a credit pack

Payload:

- `packId`

Response:

- `url`
- `provider`

3. optional `POST /billing/top-up-preview`

Purpose:

- resolve a pack ID into human-readable credit and price metadata before checkout if the UI needs it

### Extend existing billing summary

Either:

- add a nested `usage` object to the existing `GET /billing/summary`

or:

- keep `GET /billing/summary` subscription-focused and let the web app call `GET /billing/usage-summary` in parallel

Preferred choice:

- keep `GET /billing/summary` mostly subscription-focused
- add dedicated usage endpoints for detail and charts

This avoids overloading one DTO with unrelated concerns.

### Provider abstraction changes

Current provider checkout methods assume plan subscriptions.

Extend the provider abstraction so one-time credit packs can also be sold through the same boundary.

Suggested additions:

- a generic checkout discriminator such as `checkoutKind: 'subscription' | 'top_up'`
- or separate methods like `createTopUpCheckoutUrl()`

Webhook processing should then branch into:

- subscription entitlement sync
- top-up credit grant sync

Do not force top-up semantics through `EntitlementSync`.

## Web App Changes

Primary files:

- `apps/web/src/lib/api-client.ts`
- `apps/web/src/features/billing/BillingPage.tsx`
- optional new `apps/web/src/features/billing/UsageSummaryCard.tsx`
- optional new `apps/web/src/features/billing/UsageBreakdownCard.tsx`
- optional new `apps/web/src/features/billing/TopUpCard.tsx`

### UI changes

Add a first-class usage section to billing surfaces.

The billing page should show:

- current plan and subscription state
- included monthly credits
- current period usage charges
- remaining budget before hard cap
- warnings at configured thresholds
- agent and skill usage breakdown
- top-up options when enabled

### API client changes

Add typed methods for:

- `billing.usageSummary()`
- `billing.usageEvents()`
- `billing.usageBreakdown()`
- `billing.periods()`
- `billing.createTopUpCheckoutSession()`
- `billing.updateSpendCaps()`

### Existing naming cleanup

If the current fill-history route moves out of `/billing/ledger`, update the API client and any consuming screens in the same change set.

## Billing Period and Rating Rules

### Period boundaries

For the first release:

- use calendar-month periods or subscription-aligned monthly periods
- choose one and document it clearly in config and UI

Preferred choice:

- use calendar-month periods initially unless subscription alignment becomes a hard GTM requirement

Reason:

- simpler reporting
- simpler included-credit reset logic
- easier manual reconciliation

### Rating timing

For the first release:

- rate usage synchronously when usage events are recorded
- persist raw events and rated ledger effects in the same transaction

Reason:

- current event volume should be low enough
- enforcement needs up-to-date balances
- avoids adding a queue or async billing worker before necessary

If volume grows later, move from per-event sync rating to batched rollups without changing the raw-event model.

### Included credit application

At period open:

- snapshot the active plan
- resolve its included credit and caps
- write an `included_credit` ledger entry
- seed the new `billing_periods` row with that credit amount

### Top-up handling

Top-up purchases should:

- create one-time provider checkout sessions
- be fulfilled only by verified payment webhooks
- write `top_up_credit` ledger entries
- increase available balance in the open billing period immediately after successful settlement

## Migration and Rollout Phases

### Phase 1. Config and schema groundwork

Deliverables:

- new `usageBilling` operator config
- plan config usage fields
- schema migration for accounts, usage events, rate cards, periods, and ledger
- repository scaffolding

No user-facing behavior change yet.

### Phase 2. Runtime metering only

Deliverables:

- richer LLM usage fields from `packages/llm`
- worker-side insertion of raw usage events for LLM and runtime windows
- rate cards seeded by migration or operator script
- synchronous rating and period updates

Behavior:

- billing UI can remain unchanged
- no hard enforcement yet
- this phase validates correctness of event volume and totals

### Phase 3. Read models and internal visibility

Deliverables:

- `GET /billing/usage-summary`
- `GET /billing/usage-events`
- `GET /billing/usage-breakdown`
- web billing page usage widgets

Behavior:

- show users usage and remaining budget
- continue soft rollout with operator observation

### Phase 4. Spend-state enforcement

Deliverables:

- account status transitions
- session-start blocks
- pre-LLM-call hard cap enforcement
- billing-specific error codes and user-visible activity events

Behavior:

- hard caps become real platform controls

### Phase 5. Top-ups and hybrid commercialization

Deliverables:

- top-up checkout sessions
- webhook credit grants
- UI for top-up packs
- plan included-credit reset behavior

Behavior:

- users can recover from hard-limit state without operator intervention

### Phase 6. Hardening and reporting

Deliverables:

- reconciliation scripts
- operator diagnostics for mismatched credits or usage totals
- optional daily rollups or materialized summaries if query load requires them

## Suggested File-Level PR Sequence

1. `packages/domain` config changes plus new DB schema and repository
2. worker metering plus `packages/llm` usage-shape expansion
3. API read models plus billing page usage UI
4. enforcement paths in worker and API errors
5. top-up flows and webhook credit grants
6. reconciliation scripts and hardening

## Test Strategy

### Unit tests

- config parsing for plan usage packaging and `usageBilling`
- rate-card item resolution logic
- period-opening logic and included-credit application
- spend-state transitions from `active` to `soft_limited` to `hard_limited`
- webhook classification for subscription events versus top-up credit events

### Integration tests

- raw usage event insert plus ledger update transaction
- idempotency-key dedupe for repeated worker writes
- session-start block when account is hard-limited
- pre-LLM-call block when period balance reaches the hard cap
- `GET /billing/usage-summary` and `GET /billing/usage-breakdown` ownership filtering
- top-up checkout plus webhook credit grant flow

### Manual verification

1. Create a user with an open billing account and included credits.
2. Start an agent and confirm usage events appear for LLM calls and runtime windows.
3. Confirm billing summary updates in near real time.
4. Push the account over a hard cap and confirm the agent is blocked before the next LLM dispatch.
5. Purchase a top-up and confirm credits are restored only after webhook fulfillment.

## Risks and Open Questions

1. Current provider responses do not always expose clean input and output token splits. The first implementation must tolerate partial granularity without blocking billing entirely.
2. The existing `/billing/ledger` route name is misleading and will cause confusion if left in place.
3. Calendar-month periods are simpler, but subscription-aligned periods may be required later for customer expectations.
4. If enterprise customers need invoice-first, PO-based billing immediately, the ledger model is still valid but checkout and top-up UX will not be sufficient.
5. Team or workspace billing is not in the current product model, but introducing `billing_accounts` now reduces future migration pain.

## Non-Goals for This First Slice

Do not include these in the first implementation unless requirements change:

- storage billing
- network egress billing
- tool-call billing for every capability
- tax calculation overhaul
- provider-side metered billing as the source of truth
- a separate async billing worker or queue
- retroactive backfill of historical runtime telemetry into commercial charges