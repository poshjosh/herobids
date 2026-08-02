# DEX Token Safety and Canonical Guardrails Task List

**Plan:** [001-plan.md](../001-plan.md)

**Goal:** Turn the DEX token-safety plan into an execution-ready task list with
strict sequencing, file-level edit targets, and validation order.

---

## Tasks

### T1: Add shared config and domain contract scaffolding


**Approach:** Vertical slice
**Effort:** Medium (1 session)
**Depends on:** None

Add the operator-config, instance-config, and port-level types needed for the
feature without changing runtime behavior yet.

Scope:
- add `marketData.tokenSafety` operator config schema and defaults
- extend instance `RiskConfigSchema` with swap-token safety overrides
- add `SwapTokenSafetyPort` and shared request/result types
- add `safetyOverrideId` to the brokered decision payload schema

**Files:** `packages/domain/src/config/schema.ts`, `packages/domain/src/config/index.ts`, `packages/domain/src/ports/token-safety.ts`, `packages/domain/src/ports/index.ts`, `packages/domain/src/index.ts`, `packages/domain/src/agent-protocol.ts`, `config/default.yaml`

**Acceptance:** The repo has a canonical schema and port contract for token safety, and all new fields validate cleanly without yet changing search or execution behavior.

---

### T2: Build the shared market-data token policy layer


**Approach:** Vertical slice
**Effort:** Large (1-2 sessions)
**Depends on:** T1

Implement the reusable policy layer that evaluates candidate quality, promotes
canonical tokens, and returns structured safety metadata.

Scope:
- add `token-safety.ts` in market-data
- add token safety reason and candidate types
- implement canonical registry lookup
- implement liquidity, volume, age, and dead-pool evaluation
- implement deterministic ranking with canonical promotion
- keep `token-search.ts` as a thin orchestrator over the new policy layer

**Files:** `packages/market-data/src/types.ts`, `packages/market-data/src/token-safety.ts`, `packages/market-data/src/token-search.ts`, `packages/market-data/src/index.ts`

**Acceptance:** A single market-data policy surface can evaluate and rank token candidates with explicit blocked reasons and canonical promotion.

---

### T3: Add a provider-registry facade for token policy and remove duplicated thin filtering


**Approach:** Vertical slice
**Effort:** Medium (1 session)
**Depends on:** T2

Expose the shared policy through the provider registry and remove local worker
filter implementations.

Scope:
- add a high-level `tokens.search(...)` facade in the provider registry
- stop duplicating `filterSearchResults()` logic in worker search paths
- return structured safety metadata from `search_tokens`

**Files:** `packages/market-data/src/provider-registry.ts`, `packages/market-data/src/provider-registry.test.ts`, `apps/worker/src/tools/market-data.ts`

**Acceptance:** Worker-facing token search uses the shared provider-registry token facade and no longer reimplements a thin liquidity/network filter locally.

---

### T4: Fix DEX enrichment identity to use network plus address


**Approach:** Vertical slice
**Effort:** Medium (1 session)
**Depends on:** T2

Replace symbol-based discovery enrichment joins with address-based joins so
same-symbol fakes on the same network cannot inherit the wrong metadata.

Scope:
- replace `network:symbol` map helpers with `network:address` helpers
- update agent DEX venue intelligence to attach discovery metadata only on exact
  address match
- keep existing DEX watchlist behavior intact

**Files:** `apps/worker/src/venue-intelligence.ts`, `apps/worker/src/venue-intelligence.test.ts`, `apps/worker/src/agent.ts`

**Acceptance:** DEX discovery metadata is joined only when network and address both match, and same-symbol different-address tokens no longer bleed metadata into one another.

---

### T5: Add persisted token-safety override storage and repository


**Approach:** End-to-end
**Effort:** Medium (1 session)
**Depends on:** T1

Add a DB-backed one-time override mechanism that replaces the old in-memory
force-code model.

Scope:
- add `token_safety_overrides` schema file
- export it from DB schema index
- add repository methods to issue, consume, and expire overrides
- generate a Drizzle migration

**Files:** `packages/db/src/schema/token-safety-overrides.ts`, `packages/db/src/schema/index.ts`, `packages/db/src/token-safety-override-repository.ts`, `packages/db/src/index.ts`, `packages/db/drizzle/*`

**Acceptance:** The repo has a persisted, one-time, time-bound override store with repository methods suitable for worker-side token-safety enforcement.

---

### T6: Build the worker token-safety adapter and wire override issuance and consumption


**Approach:** End-to-end
**Effort:** Medium (1 session)
**Depends on:** T2, T5

Implement the market-data-backed adapter that fulfills the new domain port and
owns override issuance and consumption.

Scope:
- add a worker adapter that implements `SwapTokenSafetyPort`
- compute effective thresholds from operator config, instance overrides, and the
  dynamic liquidity multiplier
- issue override tickets when allowed
- consume override tickets atomically when provided

**Files:** `apps/worker/src/token-safety-adapter.ts`, `apps/worker/src/index.ts`, any nearby helper modules used to resolve swap identity or thresholds

**Acceptance:** The worker can perform a concrete swap-token safety check through the domain port and can issue or consume persisted override tickets correctly.

---

### T7: Inject the hard swap guard into the shared execution path


**Approach:** Vertical slice
**Effort:** Medium (1 session)
**Depends on:** T1, T6

Add the authoritative pre-execution token guard to the engine-owned decision
pipeline used by both strategy and agent flows.

Scope:
- extend `DecisionIntakeDeps` with the injected token-safety port and any needed
  instance override fields
- run the guard for swap buy paths before execution
- return a first-class pre-execution rejection instead of generic execution
  failure
- thread the injected port through `runTradingCycle()` and `TradingActor`

**Files:** `packages/engine/src/decision-intake.ts`, `packages/engine/src/trading-cycle.ts`, `apps/worker/src/trading-actor.ts`, `apps/worker/src/index.ts`

**Acceptance:** Swap buy decisions are blocked before execution when token safety fails, while orderbook paths and swap sell-only paths remain unaffected.

---

### T8: Extend the brokered decision and rejection flow for safety overrides


**Approach:** Vertical slice
**Effort:** Medium (1 session)
**Depends on:** T6, T7

Allow an agent to retry a rejected swap decision explicitly by passing a one-time
override ticket through the existing `submit_decision` path.

Scope:
- extend `submit_decision` tool params with `safetyOverrideId`
- publish the override id through the inbound broker payload
- pass it through the agent decision handler into the shared intake path
- map token-safety pre-execution rejection into `DecisionRejected` payloads with
  structured override details

**Files:** `apps/worker/src/tools/trading.ts`, `apps/worker/src/agents/agent-decision-handler.ts`, `packages/domain/src/agent-protocol.ts`, nearby tool and broker tests

**Acceptance:** A rejected agent swap decision returns a structured override ticket when policy allows it, and a resubmitted decision can consume that ticket exactly once.

---

### T9: Add focused market-data, worker, engine, and DB tests in dependency order


**Approach:** End-to-end
**Effort:** Large (1-2 sessions)
**Depends on:** T3, T4, T5, T7, T8

Add regression coverage around the shared policy layer, address-join fix,
execution-time guard, and override lifecycle.

Scope:
- market-data unit tests for canonical promotion and blocked reasons
- worker tests for address-based discovery joins and `search_tokens` responses
- engine tests for swap-guard rejection and pass-through behavior
- DB integration tests for override issue/consume/expire behavior

**Files:** `packages/market-data/src/token-search.test.ts`, `packages/market-data/src/provider-registry.test.ts`, `apps/worker/src/venue-intelligence.test.ts`, `apps/worker/src/trading-actor.test.ts`, `packages/engine/src/decision-intake.test.ts`, `packages/engine/src/trading-cycle.test.ts`, `packages/db/src/token-safety-override-repository.integration.test.ts`

**Acceptance:** The key regression cases are covered at the package boundary where they matter, especially exact address joins, swap-guard rejection, and one-time override consumption.

---

### T10: Final hardening and repo validation


**Approach:** End-to-end
**Effort:** Medium (1 session)
**Depends on:** T9

Complete the slice with validation, cleanup of duplicated code paths, and any
small docs adjustments needed by the final shape.

Scope:
- remove any leftover unused thin-filter helpers
- confirm config comments and defaults are self-documenting
- run repo-required validation
- update plan/task statuses if work begins during implementation

**Files:** touched implementation files plus any final doc cleanup in the same feature folder

**Acceptance:** The feature is ready for implementation or review with no duplicate thin search filters remaining and repo validation passing.

---

## Parallelization Notes

- **T1** and **T5** can start in parallel only if the DB override table is kept independent from the port schema details. In practice, it is safer to finish **T1** first.
- **T2** depends on **T1** because the shared policy should compile against the final config and type shapes.
- **T3** and **T4** can proceed in parallel after **T2**.
- **T6** depends on both **T2** and **T5** because it needs shared policy behavior plus persisted override storage.
- **T7** depends on **T6**.
- **T8** depends on **T6** and **T7** because the rejection payload shape should be driven by the actual injected guard behavior.
- **T9** should land after the main implementation slices exist, but narrow tests should still be added incrementally during each slice.
- **T10** is the final hardening pass.

```text
T1 (config + domain contracts) → T2 (shared market-data policy) → T3 (provider facade + search tool)
                                                             └──→ T4 (address-join fix)

T1 → T5 (override persistence) ───────────────────────────────────────────────────────┐
                                                                                      ├→ T6 (worker adapter)
T2 ────────────────────────────────────────────────────────────────────────────────────┘

T6 → T7 (engine hard gate) → T8 (brokered override flow) → T9 (tests) → T10 (hardening)
```

---

## Recommended First Slice

Start with **T1 + T2 + T4**.

That order validates the most important architectural assumptions first:

- the config and domain boundaries are correct
- the shared market-data policy can express the full safety model cleanly
- address identity is fixed before more worker behavior depends on the old
  symbol-based enrichment join

Once those are stable, the DB override flow and engine hard gate can be added on
top of a correct policy surface instead of forcing later rewrites.

---

## Validation Order

1. After **T1**, run a narrow typecheck or `pnpm lint` if no narrower command exists.
2. After **T2**, run market-data focused tests plus a narrow typecheck.
3. After **T3** and **T4**, run worker-focused tests covering search and venue intelligence.
4. After **T5**, run DB integration tests for the override repository.
5. After **T6**, **T7**, and **T8**, run engine and worker tests for the guard and override path.
6. Finish with `pnpm lint`.