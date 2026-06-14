# Payment Provider Selection and Usage Dashboard

## Objective

Separate payment-provider selection from usage-dashboard visibility.

The product should support:

- a payment-provider env/property/config surface
- `mock` in development
- `stripe`, `creem`, or any other configured provider in production
- an always-visible usage dashboard
- continuous usage records without routine operator on/off toggles

This plan does not change the commercial model itself. It changes how billing concerns are configured and surfaced so dev and prod behave predictably without conflating provider choice, dashboard visibility, and runtime record continuity.

## Problem Statement

The current implementation mixes together concerns that should stay separate:

- payment-provider selection
- usage dashboard visibility
- runtime billing activation

That creates confusing semantics such as:

- a billing page that disappears when runtime billing is disabled
- a flag that looks like it controls billing generally, when it really controls only part of the billing flow
- a runtime toggle that can create uncertainty about whether usage records are continuous
- dev setup that is harder to reason about than it needs to be

The target behavior is simpler:

- the dashboard is always available
- the payment provider is selected by config/env
- mock provider works in dev
- live providers work in production
- usage records remain continuous once the feature exists

## Desired Product Behavior

### 1. Payment-provider selection is explicit

Add a config surface for payment-provider selection, for example:

- `billing.primaryProvider: mock | stripe | creem`
- optional fallback provider if the product supports failover
- environment-variable override support

Recommended default:

- `mock` in local development
- production config chooses a real provider explicitly

### 2. Usage dashboard is always visible

The billing page should always render:

- subscription/provider summary
- usage summary section
- usage breakdown section
- usage event ledger section
- empty states when no usage data exists

The dashboard must not depend on usage enforcement being enabled.

### 3. Usage metering and ledger records remain continuous

The system should not introduce a routine operator toggle such as `usageBilling.enforcementEnabled` for normal operation.

Reason:

- turning billing behavior on Monday and off on Tuesday creates policy ambiguity and weakens trust in the continuity of records
- if the feature exists, usage events and ledger records should be written consistently
- the dashboard should reflect a stable accounting history, not a partially-disabled subsystem

Recommended answer:

- remove `USAGE_BILLING_ENABLED`
- do not replace it with a routine `usageBilling.enforcementEnabled` switch
- keep payment-provider choice under billing config
- keep usage metering and ledger writes consistently on once the feature is enabled in the product
- if an emergency operational kill switch is ever needed later, it must be explicitly named, narrowly scoped, and documented as an emergency override rather than normal operating policy

## Scope

### In scope

- config for payment-provider selection
- config cleanup so billing semantics are not conflated
- always-visible billing dashboard
- mock provider usage in dev
- removal of `USAGE_BILLING_ENABLED`
- preservation of continuous metering and ledger records
- documentation and tests for the split

### Out of scope

- redesigning the billing model
- changing commercial rate cards
- changing the ledger schema unless needed for the split
- changing live trading rollout rules
- changing subscription product logic unless it is coupled to provider selection

## Implementation Plan

### Phase 1. Introduce provider-selection config

Primary goal:

- make payment-provider choice explicit and environment-driven

Actions:

- add or confirm a config field that selects the active payment provider
- support `mock`, `stripe`, and `creem`
- wire environment overrides cleanly
- make dev default to `mock`
- make production choose a real provider explicitly

Acceptance criteria:

- the active provider is chosen from config/env
- no code path infers provider choice from usage-billing runtime flags
- mock provider can be selected without credentials

### Phase 2. Decouple dashboard visibility from enforcement

Primary goal:

- the billing dashboard should render even when no usage account or usage data exists

Actions:

- remove any UI gating that hides the entire usage section when no billing account exists
- replace it with empty-state UI
- ensure summary, breakdown, and event table can render with no rows
- ensure API endpoints return stable empty responses when there is no data

Acceptance criteria:

- Billing page is always visible
- usage sections display empty states instead of disappearing
- no user is blocked from seeing billing info because runtime billing has not yet produced records

### Phase 3. Remove runtime activation flags that fragment billing semantics

Primary goal:

- remove `USAGE_BILLING_ENABLED` and avoid replacing it with another routine toggle that fragments record continuity

Actions:

- identify flags that currently conflate:
  - provider selection
  - usage metering
  - runtime activation
  - dashboard visibility
- keep only one meaning per flag
- remove worker-local billing activation flags that are acting as shadow config
- if a true emergency override is required, specify it as a separate follow-up with explicit operational semantics and audit expectations

Acceptance criteria:

- config names match behavior
- there is no ambiguity about what is enabled
- dev and prod can be configured independently and predictably
- billing records are not dependent on operators routinely turning runtime billing on and off

### Phase 4. Update tests

Primary goal:

- lock in the desired behavior

Tests to add or update:

- mock provider can be selected from config
- production provider selection requires explicit credentials
- billing page renders usage sections even with no usage account
- usage endpoints return stable empty payloads when no account exists
- removal of `USAGE_BILLING_ENABLED` does not regress billing flows
- dashboard visibility does not depend on runtime billing activation state

Acceptance criteria:

- tests verify the new split
- existing provider tests still pass
- UI tests cover empty-state rendering

### Phase 5. Update docs

Primary goal:

- make the configuration model obvious to operators and developers

Actions:

- update billing/configuration docs
- document:
  - payment-provider selection
  - dev mock behavior
  - dashboard always visible
  - `USAGE_BILLING_ENABLED` removed
  - billing records are expected to remain continuous

Acceptance criteria:

- operators can configure dev and prod without guessing
- new contributors understand the split quickly

## Migration Notes

### Config model

Recommended shape:

- `billing.primaryProvider`
- optional `billing.fallbackProvider`
- provider-specific credentials/settings under each provider

Recommended rule:

- do not use one flag to mean both “dashboard exists” and “runtime billing is active”
- do not add a routine operator toggle that makes billing records discontinuous

### UI model

The billing page should show:

- subscription/provider status
- usage summary
- usage breakdown
- usage ledger table
- empty states if no data is present

### Runtime model

The worker or backend should:

- use the configured provider
- write mock/seeded data in dev when appropriate
- write usage records continuously once the feature is present
- never hide the dashboard because runtime billing has not yet produced records
- not depend on `USAGE_BILLING_ENABLED`

## Acceptance Criteria

This migration is complete when:

- dev can use `mock` payment-provider behavior via config/env
- production can use `stripe` or `creem` via config/env
- the usage dashboard is always visible
- empty billing state still shows the billing sections
- `USAGE_BILLING_ENABLED` is removed
- billing records remain continuous without routine operator toggles
- tests cover the split
- documentation explains the model clearly

## Suggested Rollout Order

1. Add/confirm payment-provider selection config
2. Make billing UI always render usage sections
3. Remove `USAGE_BILLING_ENABLED` and any equivalent routine runtime billing toggle
4. Update tests
5. Update docs