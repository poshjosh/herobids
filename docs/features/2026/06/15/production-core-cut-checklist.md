# Production Core Cut Checklist

Date: 2026-06-15
Status: release-ready

## Purpose

Define the MVP production-readiness boundary for HeroBids using verified repo evidence.

This document replaces the earlier binary in-cut/out-of-cut checklist with a release matrix. Each row separates:

- implementation state
- launch-gate importance
- recommended release action
- concrete evidence checked in the repo

If a row does not yet have enough verified evidence, it must remain `unknown` or `incomplete` rather than being guessed into or out of the cut.

## Governing Rules

- No backward compatibility work.
- Prefer architecturally sound solutions over stop-gap patches.
- MVP equals production-ready.
- Jupiter, 1inch, and swap-specific behavior are part of MVP, so missing swap safety work is launch-blocking.
- A row is a launch blocker when `Launch Gate = yes` and `Status != complete`.

## Column Definitions

- `Status`
  - `complete`: implementation evidence was verified in code/tests/docs and no known launch-critical gap is being recorded in this pass.
  - `incomplete`: some real implementation exists, but important gaps remain.
  - `deferred`: intentionally outside the MVP production boundary.
  - `unknown`: this pass did not verify enough evidence to classify safely.
- `Launch Gate`
  - `yes`: this must be complete before HeroBids can be called MVP production-ready.
  - `no`: useful or already implemented, but not required for the MVP production-readiness claim.
- `Impact`
  - Effect on MVP production readiness if the row is wrong or unfinished.
- `Effort`
  - Estimated remaining effort from the currently verified repo state.
- `Recommendation`
  - `ship`: keep in the MVP surface; no immediate rescoping needed.
  - `fix-before-launch`: treat as a production blocker.
  - `verify-first`: gather stronger evidence before locking the release decision.
  - `defer`: keep outside the launch gate.
  - `descope`: deliberately out of the MVP production boundary.

## Verified Release Matrix

Completed rows have been removed from this table so it only tracks remaining open or deferred release-scope items.

| # | Surface | Status | Note | Launch Gate | Impact | Effort | Recommendation | Evidence |
|---|---|---|---|---|---|---|---|---|
| 1 | Jupiter swap trading | complete | Jupiter live swap execution is proven end to end: adapter quotes and signs/broadcasts via SolanaSignerPort, confirmation polling is tested, signer enforcement is verified (fails closed without signer), focused unit coverage exists at the adapter boundary, and a canonical operator-run validation command with companion checklist is available. | yes | XL | — | ship | `packages/venues/src/jupiter-swap.ts`<br>`packages/venues/src/jupiter-swap.test.ts`<br>`packages/venues/src/jupiter-confirmation.ts`<br>`packages/venues/src/jupiter-confirmation.test.ts`<br>`packages/engine/src/swap-live-executor.ts`<br>`packages/engine/src/swap-live-executor.test.ts`<br>`scripts/ts/validate-jupiter-launch.ts`<br>`docs/test-reports/e2e-report/jupiter-validation-checklist.md` |
| 2 | 1inch swap trading | complete | The 1inch adapter is proven end to end: approval flow (including zero-reset regression path) has focused coverage, router-scoped transaction filtering is tested, raw-amount conversion is verified, and a canonical operator-run validation command with companion checklist is available. routerAddress is documented as required for production. | yes | XL | — | ship | `packages/venues/src/oneinch-swap.ts`<br>`packages/venues/src/oneinch-swap.test.ts`<br>`packages/venues/src/evm-confirmation.test.ts`<br>`packages/venues/src/oneinch.integration.test.ts`<br>`scripts/ts/validate-1inch-launch.ts`<br>`docs/test-reports/e2e-report/1inch-validation-checklist.md` |
| 3 | Swap pending-confirmation recovery and restart safety | complete | Swap recovery is fully implemented: the swap-live-executor emits deterministic submission states, confirmation pollers (Jupiter and EVM) check on-chain status, actor-level recovery reloads pending swaps on startup, timeout classification triggers halt-on-ambiguity alerts, and crash-policy applies only to confirmed post-swap exposure. Focused tests cover all recovery branches. | yes | XL | — | ship | `packages/venues/src/swap-confirmation-poller.ts`<br>`packages/venues/src/jupiter-confirmation.ts`<br>`packages/venues/src/jupiter-confirmation.test.ts`<br>`packages/venues/src/evm-confirmation.test.ts`<br>`packages/engine/src/swap-live-executor.ts`<br>`packages/engine/src/swap-live-executor.test.ts`<br>`apps/worker/src/agent-trading-actor.ts`<br>`apps/worker/src/agent-trading-actor.test.ts`<br>`apps/worker/src/trading-actor.ts`<br>`apps/worker/src/trading-actor.test.ts` |
| 4 | Risk contract integrity | complete | The agent risk contract implements the documented two-path model: creator-configured limits are immutable at runtime, operator defaults are the adjustable fallback, agent overrides are capped at operator ceilings, the runtime resolves effective values with full source attribution (user/default/agent_override), and an agent-facing read/adjust surface is available. Focused tests verify source, ceiling, adjustment, reset, and restart behavior. | yes | XL | — | ship | `packages/domain/src/agent-risk-contract.ts`<br>`packages/domain/src/agent-risk-contract.test.ts`<br>`apps/api/src/routes/agents.ts`<br>`apps/api/src/routes/agents.test.ts`<br>`apps/worker/src/agent-risk-limits.ts`<br>`apps/worker/src/agent-risk-limits.test.ts`<br>`packages/engine/src/risk-gate.ts`<br>`packages/engine/src/risk-gate.test.ts` |
| 5 | Birdeye market-data integration | deferred | Birdeye currently has config, schema, registry, and admin-surface wiring only, with `enabled: false` by default and unwired-state reporting when no API key is present. This is not a live provider integration yet. | no | S | M | defer | `config/default.yaml`<br>`packages/domain/src/config/schema.ts`<br>`packages/market-data/src/provider-registry.test.ts`<br>`apps/api/src/routes/admin.ts` |
| 6 | Admin perp venue observability panel | deferred | I did not verify matching perp-specific API or web implementation from the current code; what is present is the planning document and broader admin/observability surfaces, not the dedicated panel itself. | no | S | L | defer | `docs/features/2026/06/15/015-admin-perp-venue-observability/001-plan.md` |
| 7 | Dedicated-wallet strict reconciliation | deferred | Reconciliation infrastructure exists, but the active runtime behavior for swap venues is still shared-wallet observational mode rather than dedicated-wallet authoritative truth. Strict dedicated-wallet reconciliation is not the current production model. | no | M | XL | descope | `packages/db/src/schema/reconciliation-events.ts`<br>`packages/engine/src/reconciliation/reconcile.ts`<br>`apps/worker/src/trading-actor.ts`<br>`apps/worker/src/agent-trading-actor.ts` |

## Exit Rule

Do not call HeroBids MVP production-ready until every row with `Launch Gate = yes` is `complete`.

Rows with `Launch Gate = no` may still ship, remain partially complete, or be deferred, but they must not be misrepresented as launch blockers or as absent when verified code already exists.
