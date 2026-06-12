# Commercial Usage Ledger

## Objective

Draft the Herobids equivalent of the aitradingbot global-ledger plan, adapted to Herobids' current billing surfaces and route boundaries.

This plan is a child plan of [001-plan.md](./001-plan.md). It covers the user-visible commercial usage ledger slice only:

- usage summary read models
- commercial usage event listing
- billing-page UI for spend visibility
- breakdowns by agent, session, and meter

It does not replace the parent plan's schema, metering, rating, enforcement, or top-up work. It assumes the parent plan's Phase 1 and Phase 2 groundwork exists first.

## Current-State Findings

1. Herobids already has a top-level billing page at `/billing`, but it is subscription management only.
2. Herobids already uses `GET /billing/ledger`, but that route currently returns trading fill history, not commercial usage charges.
3. Herobids already has `agent_runtime_sessions` plus `/sessions` and `/sessions/:id`, so the commercial ledger can attach to existing session IDs instead of inventing a second session model for v1.
4. Worker runtime code already tracks in-memory token and estimated cost telemetry, but there is no durable commercial usage-event store yet.

These findings change the Herobids implementation shape materially versus aitradingbot:

- do not create a brand-new Billing page route
- do not overload the existing `/billing/ledger` route
- extend the existing billing page with usage sections
- build commercial usage APIs under distinct names

## Recommended Product Shape

### 1. Keep `/billing` as the single billing entry point

Recommended answer:

- Extend the existing billing page rather than creating a second top-level billing screen.
- Keep subscription controls at the top of the page.
- Add a first-class usage section below it.

Reason:

- Herobids already has a billing page and navigation entry.
- A second billing route would fragment account management and spend visibility.
- The parent usage-billing plan already assumes usage surfaces live inside the existing billing experience.

### 2. Treat commercial usage ledger and trading fill ledger as separate products

Recommended answer:

- Preserve the current fill-history endpoint behavior for now.
- Introduce new commercial billing routes instead of reusing `/billing/ledger`.

Reason:

- The current `/billing/ledger` route is already implemented and tested as fill history.
- The parent usage-billing plan explicitly says not to overload that route for commercial billing.
- A commercial ledger needs different filters, joins, and semantics from fill history.

### 3. Use existing runtime sessions as the drill-down anchor

Recommended answer:

- Attribute usage events to `agent_runtime_sessions.id` when available.
- Reuse existing `/sessions` and `/sessions/:id` pages/routes for session drill-down.

Reason:

- The schema already has `agent_runtime_sessions`.
- The API already exposes session history.
- This avoids creating a second session concept before the need is proven.

## Scope

### In scope

- API read models for commercial usage summary, events, breakdowns, and periods
- billing-page usage cards and ledger table
- filters for meter, agent, session, period, and date range
- spend-state banners for `soft_limited` and `hard_limited`
- joins from commercial usage records to agent names and runtime sessions

### Out of scope

- schema creation for billing accounts, usage events, rate cards, periods, and ledger entries
- worker metering writes
- synchronous rating logic
- hard-cap enforcement logic
- top-up checkout and webhook credit grants
- moving trading fill history to a new route unless that rename is bundled as follow-up cleanup

## Dependencies On Parent Plan

This plan depends on the following pieces from [001-plan.md](./001-plan.md):

1. `billing_accounts`
2. `billing_usage_events`
3. `billing_periods`
4. `billing_ledger_entries`
5. rate-card and synchronous rating flow
6. runtime writes for `llm.*` and `agent.runtime_ms`

Minimum prerequisite for this plan to start:

- parent Phase 1 complete
- enough of parent Phase 2 complete that real usage events and rated ledger effects exist in the database

## API Plan

### Route decisions

Recommended answer:

- Keep subscription summary on `GET /billing/summary`.
- Add distinct commercial usage endpoints under `/billing/usage-*`.
- Do not put commercial records on `/billing/ledger`.

### Proposed endpoints

#### `GET /billing/usage-summary`

Purpose:

- return the current account and open-period headline numbers for the billing page

Suggested response shape:

```json
{
  "account": {
    "id": "acct_123",
    "status": "active",
    "currency": "USD",
    "activePlanId": "pro"
  },
  "currentPeriod": {
    "id": "period_123",
    "periodStart": "2026-06-01T00:00:00.000Z",
    "periodEnd": "2026-06-30T23:59:59.999Z",
    "includedCreditMicrousd": 5000000,
    "usageChargeMicrousd": 1700000,
    "creditAppliedMicrousd": 1700000,
    "balanceMicrousd": 3300000,
    "softCapMicrousd": 8000000,
    "hardCapMicrousd": 10000000
  },
  "warnings": [
    { "thresholdPct": 50, "reached": false },
    { "thresholdPct": 80, "reached": false },
    { "thresholdPct": 100, "reached": false }
  ],
  "byMeter": {
    "llm.input_tokens": { "quantity": 120000, "chargeMicrousd": 420000 },
    "llm.output_tokens": { "quantity": 24000, "chargeMicrousd": 260000 },
    "llm.reasoning_tokens": { "quantity": 8000, "chargeMicrousd": 120000 },
    "agent.runtime_ms": { "quantity": 14400000, "chargeMicrousd": 900000 }
  }
}
```

#### `GET /billing/usage-events`

Purpose:

- paginated commercial usage event table for the billing page

Supported query params:

- `limit`
- `offset`
- `meterKey`
- `agentId`
- `sessionId`
- `periodId`
- `from`
- `to`

Recommended v1 exclusions:

- no free-text search
- no provider/model filters in the first UI pass unless product explicitly wants them

Suggested response shape:

```json
{
  "records": [
    {
      "id": "evt_123",
      "occurredAt": "2026-06-12T10:15:00.000Z",
      "meterKey": "llm.input_tokens",
      "quantity": 4200,
      "unit": "tokens",
      "chargeMicrousd": 14000,
      "currency": "USD",
      "agent": { "id": "agent_123", "name": "Momentum Scout" },
      "session": { "id": "sess_123", "status": "running" },
      "provider": "openrouter",
      "model": "anthropic/claude-sonnet-4-5",
      "metadata": {}
    }
  ],
  "total": 0,
  "limit": 50,
  "offset": 0
}
```

#### `GET /billing/usage-breakdown`

Purpose:

- drive cards or charts for spend by agent and spend by meter

Supported query params:

- `periodId`
- `from`
- `to`

Suggested response shape:

```json
{
  "byAgent": [
    { "agentId": "agent_123", "agentName": "Momentum Scout", "chargeMicrousd": 980000 },
    { "agentId": "agent_456", "agentName": "DEX Watcher", "chargeMicrousd": 720000 }
  ],
  "byMeter": [
    { "meterKey": "agent.runtime_ms", "chargeMicrousd": 900000 },
    { "meterKey": "llm.input_tokens", "chargeMicrousd": 420000 }
  ],
  "bySkill": []
}
```

Recommended answer on skill breakdown:

- keep the response shape capable of `bySkill`, but allow it to be empty in v1 if skill attribution is not yet populated consistently.

#### `GET /billing/periods`

Purpose:

- support current-period selector plus simple history browsing

Suggested response shape:

```json
{
  "periods": [
    {
      "id": "period_123",
      "status": "open",
      "periodStart": "2026-06-01T00:00:00.000Z",
      "periodEnd": "2026-06-30T23:59:59.999Z",
      "usageChargeMicrousd": 1700000,
      "includedCreditMicrousd": 5000000,
      "balanceMicrousd": 3300000
    }
  ]
}
```

## Backend Implementation Plan

### Phase 1. Read-model query layer

Primary files:

- `packages/db/src/` new usage-billing repository or query module
- `packages/db/src/index.ts`
- `apps/api/src/routes/billing.ts`

Recommended answer:

- Put the commercial usage queries in `packages/db`, not inlined inside the Fastify route file.

Reason:

- ownership filtering, joins, and aggregation will grow quickly
- the same queries may be reused by API routes, admin diagnostics, and future exports
- it keeps route handlers thin and testable

Deliverables:

- account-scoped current-period summary query
- usage-events list query with pagination and filters
- aggregate breakdown query
- periods list query

### Phase 2. Ownership and joins

Joins needed in v1:

- `billing_usage_events.accountId -> billing_accounts.id`
- `billing_usage_events.agentId -> agents.id`
- `billing_usage_events.sessionId -> agent_runtime_sessions.id`
- rated monetary amounts sourced from `billing_ledger_entries` or a period summary table, depending on how parent implementation lands

Recommended answer:

- all user-facing queries should scope through `billing_accounts.ownerUserId`, not through agent ownership alone

Reason:

- the commercial ledger belongs to the billing account
- agent-level joins are secondary dimensions, not the ownership primitive

### Phase 3. Route handlers

Extend [billing.ts](../../../../apps/api/src/routes/billing.ts) with:

- `GET /billing/usage-summary`
- `GET /billing/usage-events`
- `GET /billing/usage-breakdown`
- `GET /billing/periods`

Validation rules:

- clamp `limit` to a safe maximum such as `200`
- validate `from` and `to` as dates
- validate `meterKey` against known billable meters
- verify `agentId` belongs to the authenticated user's billing account scope
- verify `sessionId` resolves to a session owned by one of the user's agents

## Frontend Plan

### 1. Extend the existing billing client

Primary file:

- [api-client.ts](../../../../apps/web/src/lib/api-client.ts)

Add typed methods for:

- `billing.usageSummary()`
- `billing.usageEvents(filters)`
- `billing.usageBreakdown(filters)`
- `billing.periods()`

Recommended answer:

- extend the existing `billing` client object instead of creating a second frontend billing API module

Reason:

- Herobids already centralizes billing API methods here
- the current billing page already imports from this module

### 2. Extend the existing Billing page

Primary file:

- [BillingPage.tsx](../../../../apps/web/src/features/billing/BillingPage.tsx)

Recommended answer:

- keep the current subscription cards intact
- add usage sections underneath them

Suggested UI sections, top to bottom:

1. current plan and subscription state
2. usage summary cards
3. spend-state banner when soft-limited or hard-limited
4. breakdown section
5. usage ledger filters
6. usage ledger table

### 3. Usage summary cards

Cards should show:

- included credits this period
- usage charges this period
- remaining credit or remaining budget before hard cap
- active status such as `active`, `soft_limited`, or `hard_limited`

Recommended answer:

- use the current open period as the default view
- show both monetary totals and meter-specific quantities where helpful

### 4. Breakdown section

Start with simple cards or compact bar lists for:

- spend by meter
- spend by agent

Recommended answer:

- do not add a charting dependency in v1
- use existing card/layout primitives and simple proportional bars if needed

Reason:

- this keeps the slice aligned with the existing frontend style
- summary plus table is sufficient before deeper analytics work

### 5. Usage ledger filters

Recommended filters:

- meter dropdown
- agent dropdown
- session dropdown or session ID quick filter
- period dropdown
- optional custom date range

Recommended answer:

- make period the primary filter, with custom date range as an advanced override

Reason:

- billing is period-shaped by default
- period-first filtering reduces user confusion around reset windows and credits

### 6. Usage ledger table

Recommended columns:

- occurred at
- meter
- quantity
- billed amount
- agent
- session
- provider/model summary
- metadata preview

Recommended answer:

- keep provider/model in a single compact column to prevent table sprawl
- link session IDs to existing session detail screens when possible

### 7. Empty and blocked states

Required states:

- no usage yet
- usage exists but current filter set is empty
- hard-limited account banner
- API failure with retry

## Suggested File List

### Backend

- [billing.ts](../../../../apps/api/src/routes/billing.ts)
- `packages/db/src/billing-usage-read-model.ts` or equivalent new query module
- [index.ts](../../../../packages/db/src/index.ts)

### Frontend

- [api-client.ts](../../../../apps/web/src/lib/api-client.ts)
- [BillingPage.tsx](../../../../apps/web/src/features/billing/BillingPage.tsx)
- optional new billing subcomponents in `apps/web/src/features/billing/`

### Tests and docs

- [billing.test.ts](../../../../apps/api/src/routes/billing.test.ts)
- [user-acceptance-tests.md](../../../tech/user-acceptance-tests.md)

## PR Sequence

1. add DB read-model queries for usage summary, events, breakdowns, and periods
2. add billing API routes with ownership filtering and query validation
3. extend frontend billing client types and methods
4. add usage summary and breakdown cards to the billing page
5. add usage ledger filters and paginated table
6. add tests and user-acceptance coverage

## Test Plan

### API tests

- summary returns only the authenticated user's billing account data
- usage-events pagination and filters work together correctly
- unknown `agentId` or cross-user `agentId` is rejected
- unknown `sessionId` or cross-user `sessionId` is rejected
- period list excludes other users' periods

### Frontend tests

- billing page renders subscription and usage sections together
- usage summary cards render current period values
- filter changes reset pagination
- empty state renders when no usage events exist
- hard-limited banner renders when account status changes

### Manual verification

1. seed a user with an open billing account and rated usage data
2. open `/billing` and confirm subscription controls still work
3. confirm usage summary matches the current open period
4. filter by agent and confirm only that agent's events remain
5. open a session-linked row and confirm it links cleanly to session history

## Risks

1. The existing `/billing/ledger` name is misleading and will continue causing confusion until trading fills are renamed or commercial routes are clearly documented.
2. Skill-level usage breakdown may be sparse at first if `skillId` attribution is not consistently populated.
3. If rating output is stored only as aggregate period totals, per-event billed amount display may need a join strategy or derived calculation that should be decided early.

## Open Questions

1. Should the UI display both quantity and priced amount for every row, or only the priced amount plus meter type? Recommended answer: show both in v1 because users need explainability.
2. Should period selection be calendar-month only in the first UI pass? Recommended answer: yes, align the UI to the parent plan's preferred calendar-month model unless GTM requires subscription-aligned periods before launch.
3. Should trading fill history remain under `/billing/ledger` during the first release of usage billing? Recommended answer: yes for the initial release, but log a follow-up cleanup plan to move or rename it.