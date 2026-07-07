# Watch System Redesign Follow-Up

## Status

- Draft
- Date: 2026-07-07

## Why This Follow-Up Exists

The first watch-system redesign delivered the main structured-watch behavior:

- structured watch records with purpose, coverage, and pinned identity
- enriched watch-threshold wake payloads
- narrowed scout/judge gating
- conservative handling of legacy watches during coverage evaluation

But the implementation still falls short of the intended steady-state contract in two important ways:

1. open-position identity is still not canonical end to end
2. watch linkage is still caller-supplied rather than worker-derived

This follow-up plan completes the simplification path discussed after the review:

- keep the current structured watch model
- stop treating legacy compatibility as a design constraint
- make the current structured shape the only supported watch shape
- finish canonical position/watch linkage so coverage no longer depends on same-symbol heuristics

## Assumptions

This follow-up assumes the following product and engineering decisions:

1. Backward compatibility with legacy watch records is not required.
2. The current structured watch shape is the correct end state; we are not redesigning a brand new “v1”.
3. The important remaining work is canonical position identity and worker-owned linkage, not renaming schema versions.
4. Conservative behavior is still preferred over falsely treating a position as protected.

## Remaining Problems To Solve

### 1. Position identity is still not canonical at coverage time

Current state:

- `apps/worker/src/agent.ts` passes only `symbol` and `side` into coverage evaluation.
- `packages/db/src/schema/positions.ts` persists `venue` and `symbol` but not a canonical `instrumentId`.
- `apps/worker/src/position-coverage.ts` still documents that instrument-id matching is unreachable for most live positions.

Consequence:

- a trustable watch may still match the wrong same-symbol exposure when the runtime lacks a venue-specific or instrument-specific position key
- the system is safer than before, but it still does not satisfy the plan’s intended canonical linkage contract

### 2. Coverage linkage is still agent-supplied rather than worker-derived

Current state:

- `apps/worker/src/tools/watch.ts` accepts `coverage.positionKey` as optional free input
- the worker does not derive that key from live position state when a watch is intended to protect an open position

Consequence:

- the linkage contract is not owned centrally by the worker
- a caller can provide a mismatched or stale key shape
- protection quality still depends on the agent guessing the same key contract as the runtime

### 3. Legacy-oriented code paths still exist despite the simplification goal

Current state:

- parsing and runtime behavior still distinguish between legacy and structured watches
- symbol-fallback logic still exists in coverage matching and monitor behavior for old records
- tests still cover legacy cases that would become irrelevant once the structured shape is mandatory

Consequence:

- extra branching and cognitive overhead remain in the watch stack
- the code is more complex than needed if the project no longer cares about legacy compatibility

### 4. Small review observations remain open

These are not blocking design issues, but they should be resolved as part of the cleanup:

- `apps/worker/src/agents/market-monitor-protocol.test.ts` does not include `schemaVersion` in its “all optional fields” fixture
- `apps/worker/src/market-intelligence/monitor.ts` does not mirror `note` into the wake context object even though the payload carries it
- `apps/worker/src/market-intelligence/monitor.ts` logs the original watch symbol rather than the effective pinned symbol
- `apps/worker/src/position-coverage.ts` checks matchability before trustability, wasting symbol-normalization work on watches that will later be rejected

## Target End State

After this follow-up:

- the current structured watch shape is the only supported watch shape
- the worker derives one canonical `positionKey` contract for live positions
- watches intended to protect a position use that same key contract automatically
- coverage evaluation does not rely on same-symbol fallback for normal operation
- monitor, runtime, and protocol tests all align on one canonical contract
- legacy parsing and compatibility branches are removed or isolated behind an explicit one-time migration decision

## Design Direction

### A. Keep the current structured model

Do not invent a new watch schema.

Use the current structured model as the only supported model:

- `purpose`
- canonical instrument identity
- `coverage.positionKey`
- pinned lookup identity
- optional `schemaVersion` only if it remains useful as inert metadata

### B. Make position identity worker-owned

The worker should define and own one canonical `positionKey` derivation rule.

Minimum requirement:

- the same position must produce the same key in all relevant flows
- the key must distinguish venue-specific exposures
- spot positions should use chain/address when available
- perp positions should use canonical venue/instrument identity rather than prompt-facing symbol text

### C. Remove legacy as an operating mode

If backward compatibility is not required, the runtime should stop behaving as if legacy watch shapes are a normal steady-state input.

That means:

- no new branches designed to preserve legacy semantics
- no protective-coverage logic optimized around mixed-version coexistence
- either reject non-structured watches loudly or provide a one-time cleanup path and then remove support

## Implementation Plan

### 1. Define the canonical live `positionKey` contract

Files likely involved:

- `apps/worker/src/position-coverage.ts`
- `apps/worker/src/agent.ts`
- `packages/db/src/schema/positions.ts`
- any position-tracker or venue-identity helpers already responsible for canonical instrument naming

Change:

- choose one canonical key contract for perps and spot
- ensure live open positions expose enough identity to derive that key without symbol heuristics
- document the contract directly in code and tests

Success criteria:

- coverage evaluation can derive stable keys from live positions without same-symbol ambiguity
- the “instrument-id tier is unreachable” comment is no longer true

### 2. Flow canonical identity into persisted positions

Files likely involved:

- `packages/db/src/schema/positions.ts`
- repositories and position-writer code paths
- any actor/execution code that opens or updates positions

Change:

- persist whatever canonical identity is required for `positionKey` derivation
- backfill or recompute open-position identity on load if schema changes are minimized
- prefer one clear source of truth over ad hoc reconstruction

Success criteria:

- open positions carry enough information for venue-specific identity
- coverage logic does not need to infer canonical identity from display symbols

### 3. Make protective-watch linkage worker-derived

Files likely involved:

- `apps/worker/src/tools/watch.ts`
- worker-side trade or position helpers
- tests around watch creation and position coverage

Change:

- when a watch is explicitly intended to protect an open position, derive `coverage.positionKey` from live runtime data instead of trusting arbitrary free-form input
- keep agent input narrow: identify the target position, not the exact internal linkage string
- reject ambiguous protective-watch creation when the target position cannot be resolved safely

Success criteria:

- the worker, not the agent, owns the linkage contract
- protective-watch creation cannot silently attach to the wrong position-key shape

### 4. Remove legacy parsing and runtime fallback paths

Files likely involved:

- `apps/worker/src/watch-types.ts`
- `apps/worker/src/position-coverage.ts`
- `apps/worker/src/tools/watch.ts`
- `apps/worker/src/market-intelligence/monitor.ts`
- tests covering legacy coexistence

Change:

- remove legacy watch parsing branches or turn them into loud validation failures
- delete fallback behavior that exists only to keep old watch shapes alive
- simplify tests to reflect a single supported watch contract

Success criteria:

- there is one supported persisted watch shape
- the runtime no longer carries mixed legacy/structured semantics
- code paths and tests are materially smaller and easier to reason about

### 5. Clean up the remaining review observations

Files likely involved:

- `apps/worker/src/agents/market-monitor-protocol.test.ts`
- `apps/worker/src/market-intelligence/monitor.ts`
- `apps/worker/src/position-coverage.ts`

Change:

- add `schemaVersion` to the worker-level protocol test fixture
- decide whether wake context should also carry `note`; if yes, mirror it consistently
- log effective pinned symbol/identity where that improves operator clarity
- reorder trustability checks before symbol fallback matching if the simplified code still needs that optimization

Success criteria:

- tests match the actual protocol contract
- payload/context behavior is internally consistent
- remaining paper cuts from the code review are closed deliberately

### 6. Revalidate scout/judge behavior on the simplified contract

Files likely involved:

- `apps/worker/src/scout-gating.ts`
- `apps/worker/src/agent.ts`
- runtime and integration tests

Change:

- rerun focused gating tests once canonical position identity and linkage are complete
- ensure quiet but fully covered positions still allow scout
- ensure uncovered or triggered protective situations still force judge

Success criteria:

- gating behavior matches the original redesign intent without legacy caveats
- test coverage reflects the simplified single-shape design

## Test Strategy

### Unit tests

- canonical `positionKey` derivation for perps and spot
- worker-derived linkage for protective-watch creation
- coverage evaluation without legacy fallback branches
- monitor/protocol fixtures that include the final canonical wake shape

### Integration tests

- open position plus protective watch created through the worker resolves to the same `positionKey`
- pinned watch identity flows through monitor and wake payloads
- scout/judge gating stays quiet for fully covered positions and escalates for uncovered or triggered ones

### Validation command

- `pnpm lint`
- focused vitest suites for watch tools, monitor, position coverage, runtime composition, and scout gating

## Exit Criteria

- current structured watch shape is the only supported shape
- live positions expose canonical identity sufficient for stable `positionKey` derivation
- worker-derived protective-watch linkage replaces free-form caller-supplied key strings
- same-symbol heuristic matching is no longer required for normal protected-position behavior
- watch protocol tests, runtime behavior, and monitor behavior all align on one canonical contract
- watch-system tests pass on the simplified single-shape model

## Open Questions

1. Should `schemaVersion` remain as inert metadata after legacy support is removed, or should it be deleted entirely?
2. Is the cheapest safe path to add canonical identity columns to `positions`, or can the worker derive them reliably from existing persisted venue data?
3. For protective-watch creation, what is the minimal agent-facing input that identifies the target position without exposing internal key-shape details?
4. Do we want a one-time migration/cleanup command for old Redis watches, or should unsupported watch records simply fail loudly once this follow-up ships?
