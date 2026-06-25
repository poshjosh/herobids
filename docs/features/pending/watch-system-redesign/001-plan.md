# Watch System Redesign

## Status

- Draft
- Date: 2026-06-25

## Problem

The current watch system is good enough for basic threshold alerts, but too weak to support safe runtime decisions about open-position coverage and scout versus judge escalation.

Today, watch state is spread across multiple worker modules and an event schema, but the stored watch record is still mostly an unstructured threshold entry:

- `apps/worker/src/tools/watch.ts` stores `symbol`, `chain`, `thresholdPrice`, `condition`, `note`, and last-check fields in Redis JSON.
- `apps/worker/src/market-intelligence/monitor.ts` duplicates the watch shape when evaluating and publishing wakes.
- `apps/worker/src/agent.ts` separately parses raw watch JSON into runtime state.
- `packages/domain/src/agent-protocol.ts` emits watch-threshold wake payloads without any explicit statement of watch purpose or position coverage.

That design creates four concrete problems:

1. The runtime cannot tell whether an open position is protected, unmanaged, or only loosely monitored.
2. Scout/judge gating must rely on coarse heuristics such as `hasOpenPositions`, which over-escalates quiet monitoring ticks.
3. Wake payloads tell the agent that a price threshold fired, but not whether the watch represents stop loss, take profit, re-entry, or passive discovery.
4. Position/watch linkage is heuristic and unstable because positions and watches use different identity shapes.

The eval investigation on 2026-06-25 exposed the cost of this design directly: the blanket open-position escalation in `apps/worker/src/scout-gating.ts` kept bypassing scout even when all watched thresholds were idle and no position-management action was needed.

## Goals

- make watch records explicit enough for the runtime to reason about protection and intent
- unify watch identity so one watch means one concrete instrument over time
- support reliable matching between open positions and their protective watches
- carry structured watch metadata through storage, runtime state, and wake payloads
- narrow scout/judge escalation so open positions alone do not force judge when coverage is sufficient and nothing fired
- preserve compatibility with existing Redis-backed watch storage during rollout

## Non-Goals

- moving watches from Redis to SQL in this phase
- redesigning all reminder or wake semantics beyond the watch-related parts needed by this feature
- introducing a full strategy-order graph or persistent bracket-order model
- solving every possible multi-leg or portfolio-level protection policy in the first pass

## Product Decisions Assumed By This Plan

This plan assumes the platform wants the following behavior:

1. Open positions should not force judge solely because they exist.
2. Judge should still run when at least one open position lacks sufficient protective watch coverage.
3. A watch must carry machine-readable intent rather than relying on free-text `note` parsing.
4. A watch created through ambiguous discovery must still resolve to one stable tracked instrument before long-lived monitoring begins.

## Current Weaknesses To Fix

### 1. Unstructured watch intent

The current watch schema can tell the system that a threshold exists, but not why it exists.

Examples of intents the runtime currently cannot distinguish:

- stop-loss protection for an open BTC perp
- take-profit watch for the same BTC perp
- re-entry reminder for a flat token
- discovery-only monitor for a token the agent may trade later

### 2. No canonical coverage model

There is no first-class answer to the question: "Which positions are protected by which watches?"

Any attempt to enforce "judge if an open position has no watch" is therefore heuristic unless the redesign introduces a canonical linkage contract.

### 3. Duplicated schema across layers

Watch shape is redefined independently in tool code, monitor code, runtime parsing, and protocol schemas. That invites drift and makes future changes expensive.

### 4. Gating is forced to use blunt signals

`resolvePreScoutDecision(...)` currently escalates on any open position because the runtime lacks a stronger signal such as:

- uncovered open position exists
- protective watch fired
- protective watch is stale or invalid
- explicit judge-level position-management reminder exists

## Target End State

After this redesign, the system should have one coherent watch contract:

- a watch has explicit identity, purpose, and optional linkage metadata
- runtime state can answer whether each open position has protective coverage
- wake payloads tell the agent what kind of watch fired and what exposure it relates to
- scout/judge gating escalates on actionable management conditions, not merely on exposure existence
- legacy watch records remain readable during migration, but new writes use the structured shape

## Canonical Watch Model

### Required watch fields

Every persisted watch should include the existing threshold fields plus structured identity and intent fields.

Suggested shape:

```typescript
type WatchPurpose =
  | 'entry'
  | 'exit'
  | 'stop_loss'
  | 'take_profit'
  | 'monitor'
  | 'alert';

interface WatchInstrumentIdentity {
  venue: 'hyperliquid' | 'dex';
  instrumentId: string;
  symbol: string;
  chain?: string;
  address?: string;
}

interface WatchCoverageLink {
  actorType?: 'agent' | 'bot' | 'user' | 'system';
  actorId?: string;
  positionKey?: string;
  intentGroup?: string;
}

interface WatchEntryV2 {
  watchId: string;
  instrument: WatchInstrumentIdentity;
  requestedSymbol?: string;
  requestedChain?: string;
  purpose: WatchPurpose;
  thresholdPrice: number;
  condition: 'above' | 'below';
  note?: string;
  coverage?: WatchCoverageLink;
  createdAt: string;
  lastConditionMet: boolean | null;
  lastCheckedAt?: string;
  lastPriceUsd?: number;
  schemaVersion: 2;
}
```

This exact interface does not need to live in one file verbatim, but the contract does need one shared source of truth.

### Minimum required semantics

- `purpose` tells the runtime what the watch is for.
- `instrument.instrumentId` is the canonical identity used for repricing and coverage matching.
- `coverage.positionKey` links a watch to one specific open position when the watch is meant to protect it.
- `schemaVersion` lets the worker distinguish legacy records from structured records without guessing.

## Position Coverage Model

The redesign should introduce an explicit notion of protective coverage rather than equating "any watch exists" with "position is managed."

### Protective watch definition

For scout/judge gating, a position counts as covered only when at least one active watch linked to that position has a protective purpose:

- `stop_loss`
- `take_profit`
- `exit`

`entry`, `monitor`, and generic `alert` watches do not count as protective coverage for an already-open position.

### Position key contract

The worker should derive a stable `positionKey` for each open position and use that same key when creating or updating linked watches.

The contract must be explicit about perp versus spot identities:

- Hyperliquid perps should use a canonical venue/instrument identifier, not only prompt-facing symbol text.
- DEX spot positions should use chain plus token address when available, not only bare token symbol.
- Symbol-only fallback should be treated as legacy compatibility, not the preferred steady-state path.

### Coverage evaluation output

Add a small internal evaluator that turns `openPositions + activeWatches` into a structured summary such as:

```typescript
interface PositionCoverageStatus {
  positionKey: string;
  protectiveWatchCount: number;
  hasProtectiveCoverage: boolean;
  triggeredProtectiveWatch: boolean;
  staleProtectiveWatch: boolean;
}
```

That summary becomes the input to runtime gating instead of raw `hasOpenPositions`.

## Wake And Runtime Semantics

### Wake payload changes

Extend watch-threshold wake payloads so the receiver can see structured intent, not just price threshold details.

Required additions to the shared protocol:

- `purpose`
- canonical instrument identity fields
- optional `coverage.positionKey`
- optional `schemaVersion`

This keeps the worker runtime, journal, and any future UI consumers aligned on one meaning for a watch event.

### Runtime state changes

Update runtime composition so prompt/runtime state can represent:

- active structured watches
- open-position coverage summaries
- whether any uncovered position exists
- whether any protective watch triggered on this wake

The prompt does not need to dump full watch JSON. It should summarize only the decision-relevant parts.

## Scout/Judge Gating Redesign

Replace the current blanket open-position escalation rule with structured escalation reasons.

### Proposed escalation conditions

Judge should be forced before scout when any of the following is true:

1. First tick bootstrap.
2. A judge-originated reminder is due.
3. A watch wake fired for a protective watch tied to an open position.
4. At least one open position has no protective coverage.
5. Protective coverage exists but is stale, invalid, or cannot be evaluated safely.

Scout-level ticks should remain allowed when all of the following are true:

- open positions exist
- every open position has protective coverage
- no protective watch fired
- no judge reminder is due
- no other deep-thinking trigger applies

This is the core behavioral change that reduces unnecessary judge spend without weakening safety.

## Source Of Truth Consolidation

The redesign should eliminate schema drift by consolidating watch types and parsers.

### Required cleanup

- define the canonical watch schema in one shared module
- stop duplicating `WatchEntry` types in multiple worker files
- use one parser/validator for Redis watch records
- use the same type family in watch tools, monitor, runtime composition, and shared wake protocol mapping

The shared type may live in `packages/domain` if it is part of cross-layer contracts, or in a worker-local module if only the mapped wake payload crosses the package boundary. The important part is one authoritative definition per contract.

## Backward Compatibility And Migration

Watches are currently Redis-backed JSON records, which makes additive evolution feasible without a DB migration.

### Migration policy

1. New watch writes should use `schemaVersion: 2` and the structured fields.
2. Legacy watch reads should still parse if they only contain the old shape.
3. Legacy records should be treated as unlinked unless they can be upgraded deterministically.
4. The runtime should not assume that a legacy watch protects a position unless the upgrade path can prove it.

### Upgrade strategy

Phase 1 should prefer safe coexistence over aggressive backfill.

- exact instrument identity can be pinned for newly created watches
- legacy watches can continue to trigger threshold alerts
- coverage-sensitive logic should be conservative around legacy records

If a later migration pass is needed, it should be explicit and auditable rather than silently rewriting records at runtime.

## Implementation Plan

### 1. Introduce canonical watch types and parsing

Files:

- `apps/worker/src/tools/watch.ts`
- `apps/worker/src/market-intelligence/monitor.ts`
- `apps/worker/src/runtime-composition.ts`
- `apps/worker/src/agent.ts`
- shared watch-type module to be chosen during implementation

Change:

- define structured watch types
- add a shared parser for legacy and v2 records
- remove duplicated local watch interfaces where practical

### 2. Add canonical instrument identity to watch creation

Files:

- `apps/worker/src/tools/watch.ts`
- existing price/market resolution code used by watch creation
- any supporting market-data abstractions

Change:

- resolve watch targets to one stable instrument identity at create time
- persist both requested input and canonical resolved identity where useful for observability

Dependency: step 1.

### 3. Add purpose and coverage metadata

Files:

- `apps/worker/src/tools/watch.ts`
- tool schemas exposed to the agent
- runtime watch summaries and parser tests

Change:

- extend watch creation inputs with structured `purpose`
- allow optional linkage metadata for one target position
- keep defaults strict enough that new watches are not silently ambiguous

Dependency: steps 1 and 2.

### 4. Extend wake payload schemas

Files:

- `packages/domain/src/agent-protocol.ts`
- `apps/worker/src/market-intelligence/monitor.ts`
- wake protocol tests

Change:

- propagate purpose and canonical identity into threshold-trigger events
- include linkage metadata when present

Dependency: steps 1 through 3.

### 5. Add position coverage evaluation

Files:

- worker runtime modules that already load open positions and active watches
- likely a new focused helper near scout gating or runtime composition

Change:

- compute per-position protective coverage status
- expose a concise runtime summary and a machine-usable gating input

Dependency: steps 1 through 4.

### 6. Replace blanket open-position escalation

Files:

- `apps/worker/src/scout-gating.ts`
- `apps/worker/src/agent.ts`
- related gating and runtime tests

Change:

- stop using `hasOpenPositions` alone as the judge-forcing signal
- force judge on uncovered, triggered, or unsafe-to-evaluate protective states instead

Dependency: step 5.

### 7. Tighten runtime summaries and prompts

Files:

- `apps/worker/src/runtime-composition.ts`
- prompt composition tests

Change:

- summarize coverage and active protective states compactly
- avoid dumping large watch metadata blobs into the prompt

Dependency: steps 4 through 6.

### 8. Validation and rollout cleanup

Files:

- worker tests
- protocol tests
- any eval harness or docs touched during rollout

Change:

- add focused coverage tests
- verify eval behavior matches the narrowed escalation policy
- document any legacy-watch limitations during transition

Dependency: steps 1 through 7.

## Test Strategy

### Unit tests

- watch parser tests for legacy and v2 records
- watch creation tests for purpose, canonical identity, and linkage validation
- position coverage tests for covered, uncovered, stale, and triggered states
- scout-gating tests that prove open positions alone no longer force judge

### Protocol tests

- shared schema tests for enriched watch-threshold wake payloads
- monitor tests that publish the new payload shape correctly

### Runtime tests

- runtime composition tests for compact coverage summaries
- agent-loop tests that verify judge escalation only on actionable management conditions

### Validation command

- `pnpm lint`

## Rollout Notes

- This redesign changes semantics, not just data shape.
- The riskiest part is falsely treating a position as protected when the linkage is weak or legacy.
- During transition, conservative escalation is preferable to silent under-protection.
- The final scout/judge narrowing should ship only after coverage evaluation is trustworthy.

## Exit Criteria

- new watches persist structured purpose and canonical identity
- open-position coverage can be evaluated without free-text heuristics
- watch wake payloads carry enough metadata to explain why the alert matters
- scout is allowed for quiet, fully covered open-position ticks
- judge is forced for uncovered or triggered protective situations
- legacy watches remain readable, with conservative behavior where linkage is incomplete
- `pnpm lint` passes after implementation

## Open Questions

1. Should `watch_token` require `purpose` explicitly for every new watch, or allow a default such as `monitor`?
2. What is the exact canonical `positionKey` contract for each venue so linkage stays stable across restarts and prompt formatting changes?
3. Should a take-profit-only watch count as protective coverage by itself, or do we require at least one downside-protection watch for the position to count as managed?
4. Do we want an explicit tool for attaching or repairing coverage links on existing watches, or is that unnecessary for the first rollout?