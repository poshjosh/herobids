# Implementation Plan: Active Preset State, Transition Execution, And Assessment Tools

**Status:** Draft - rewritten after implementation review
**Depends on:** [007-assessment-billing-completion-plan.md](./007-assessment-billing-completion-plan.md), [008-real-evidence-and-scorecards.md](./008-real-evidence-and-scorecards.md), and [009-llm-preset-ranking.md](./009-llm-preset-ranking.md)
**Purpose:** Replace assessment-tool stubs and audit-only transitions with authoritative preset bindings, exact-artifact recommendation, and risk-preserving transition execution.

## Authoritative Plan

This section supersedes the archived draft below. Implement only this section.

### Transition Scope Decision

An assessment artifact is per canonical identity. It must not silently change a global agent preset merely because one symbol ranked differently.

Phase 1 applies an approved artifact only to a **per-identity future-entry preset binding**. The agent's default preset remains a separate explicit binding. The technical scan/decision path resolves the most-specific active binding for a candidate identity, then falls back to the default binding. A future global transition requires a separate multi-identity assessment/scope contract and is out of scope.

Add an authoritative first-class preset-binding state, for example `agent_preset_bindings`, with:

- agent ID and scope (`default` or canonical identity);
- active preset key, style tier, mechanically derived behavior version, and applied preset/config version;
- source artifact/transition ID, applied timestamp, and binding status;
- unique constraint per agent and scope.

`UnifiedAgentConfig.allowedPresets` remains policy, not mutable active state. The effective technical configuration is a derived, versioned projection from the binding's preset plus permitted agent overrides. Do not invent `agents.metadata.strategyPreset`; that column does not exist.

### One Transition Service

Introduce a worker-owned `PresetTransitionService`. `apply_preset_transition` is a thin adapter; it must not directly write transition rows, journal a fictional application, or use hardcoded `unknown`, `v1`, or `0` values.

The service receives the requesting agent, exact artifact ID, target preset, requested transition mode, reason, and a durable idempotency key. It performs:

1. Load the exact artifact, reject expired/superseded artifacts, and validate the requested identity scope matches the binding to be changed.
2. Resolve the agent's current binding, preset behavior version, style tier, allowed-preset policy, transition policy, creator locks, mutable overrides, dwell time, and daily transition cap.
3. Verify the artifact candidate set and target preset are compatible with that deterministic policy. Never use an LLM score cutoff as the allowed-preset authority.
4. Build a pure `PreparedPresetTransition` using `applyPresetToAgent`, current effective config, and the risk-precedence rules used at API write time.
5. Persist transition intent before config or position side effects, then make configuration/binding state durable and notify the running actor with a versioned reload request.
6. Await/record actor acknowledgement or reconciliation. A failed reload is a failed transition, not an applied one.
7. Persist exact old/new keys, behavior versions, identity snapshot, artifact ID, transition scope/mode, position-action results, outcome, and reason.

Use an explicit durable state machine such as `prepared`, `applying`, `applied`, `deferred`, `rejected`, `failed`, and `partially_applied`. Do not mark a transition `accepted`/`applied` before all required effects have succeeded.

### Risk And Position Rules

Creator-locked risk always wins over preset defaults. Build transition configuration through one tested precedence function rather than copying fields across tools.

`entries_only` changes only the future-entry binding/configuration. It creates no position action.

`entries_and_tighten_existing` is permitted only when the agent policy enables it. For each scoped open position, prepare a persisted `PositionTransitionAction` before dispatching it through the actor/execution-owned protection interface. Allowed actions are tightening protection, reducing exposure, partial exit, or shortening a configured hold policy when explicitly supported. It must reject widening a stop, removing protection, adding to a losing position, or overwriting a creator lock.

The service must await an execution acknowledgement or reconcile actual position state before recording success. A failed position action yields a failed/partial transition record with explicit position-level status; it must not merely write a journal line claiming future entries changed.

### Rollout Mode

Add an explicit validated assessment transition mode to persisted agent config, defaulting to `recommend_only`. `recommend_only` allows assessment and recommendation but blocks any binding/config/position mutation. An apply-capable mode is accepted only when operator rollout policy permits it and is exercised in isolated test/staging configuration first.

The existing `apply_preset_transition` check for `platformAssessment.mode` is not enough because the current schema does not define that field. Add it to the schema, API validation, effective-config resolver, and actor contract. Never silently treat a missing or unrecognised mode as apply-capable.

### Tool And Identity Wiring

Do not proliferate optional `ToolContext` callbacks for venue, style tier, current preset, open-position count, symbols, token maps, billing, and transitions. Expose two typed worker-owned ports instead:

- `AssessmentRequestPort` from `007` for the single/batch billable request operations;
- `PresetTransitionPort` for recommendation and application operations.

Bind them through the selected worker/tool transport in `007`. Tools are thin validators/adapters and do not query assessment tables directly for business decisions.

Create an `AssessmentIdentityResolver` adapter at the worker boundary. It wraps venue-specific normalization/validation and DEX token resolution:

- orderbook/perp resolution uses `VenueInstrumentCache` normalization and readiness/failure status, not a raw unnormalised `Set` and not fail-open acceptance for a billable request;
- swap/dex resolution uses the existing canonical token resolver with explicit binding/network context; ambiguous tokens return a resolvable error and no billing occurs;
- venue family and instrument kind are inferred only from an unambiguous agent binding. Otherwise tools require an explicit disambiguator;
- style tier comes from the authoritative preset binding/policy, never a static duplicate YAML map or a hardcoded `standard` fallback.

### Tool Contracts

| Tool | Required behavior |
|---|---|
| `get_market_preset_assessment` | Resolve identity through the adapter and call `AssessmentRequestPort`. Return request ID, identity, billing/cache outcome, artifact ID, timestamps, and retry semantics. |
| `assess_strategy_preset` | Bounded batch adapter over the same port. It may not implement a second cache or billing path. Decide whether its public name is retained or deprecated, then update tool catalog, skill references, and tests atomically. |
| `recommend_preset_transition` | Requires an exact fresh artifact ID or resolves an already-fresh exact artifact without starting a request. Combines artifact with binding, local policy, transition history, and scoped position state. |
| `apply_preset_transition` | Requires the exact recommended artifact and delegates entirely to `PresetTransitionService`. It returns durable transition ID/state and action results. |

Tool descriptions and categories must reflect side effects and configured capability policy. Do not advertise an action as applied when it only wrote an audit record.

### Required Changes And Tests

| Surface | Change |
|---|---|
| DB schema | Add preset bindings and transition/action state; replace incomplete audit-only transition shape as needed. |
| Domain/config | Add rollout mode, active-binding types, identity resolver and transition service contracts, and risk-precedence preparation types. |
| Worker/actor runtime | Resolve bindings for candidate execution; reload versioned binding/config and acknowledge application. |
| Assessment tools | Delegate through typed ports; remove hardcoded tier/preset/version/position values and direct table business logic. |
| API/config path | Validate new mode and policy at write time; reject invalid transition settings. |

Unit tests must cover identity resolution, binding precedence, exact-artifact checks, style/allowed-policy checks, rollout mode, dwell/day limits, and every risk restriction. Integration tests must prove a permitted `entries_only` change updates the authoritative binding and actor state, while a permitted tightening mode creates and reconciles position actions. They must also prove no configuration or position mutation occurs in `recommend_only`, on stale/mismatched artifacts, or after an actor/action failure.

This plan is complete only when [006-followup-plan.md](./006-followup-plan.md) C6 and C7 have executable proof.

## Archived Draft - Do Not Implement

---

## 0. Scope

This plan covers wiring real agent context into the three assessment tools so they can resolve venue, preset, and position data without requiring the agent to manually specify every parameter.

It does NOT cover:
- Core assessor logic (Plans 008, 009)
- Review scheduler (Plan 010)
- Request service stubs (Plan 011)
- Billing (Plan 007)

---

## 1. Current State (what's broken)

### 1.1 `get-market-preset-assessment.ts`

Four TODOs and one stub:

```ts
// TODO: resolve from agent config (agentConfigOps.getCurrentConfig()) or binding when ToolContext exposes it.
if (!venueFamily) {
  return { success: false, error: 'venueFamily is required...' };
}

const resolvedInstrumentKind = instrumentKind ?? 'orderbook';

// TODO: resolve styleTier from agent's active preset tier when ToolContext exposes it
const identityResult = resolveAssessmentIdentity({
  instrumentKind: resolvedInstrumentKind,
  venueFamily,
  styleTier: 'standard',  // ← hardcoded!
  symbol,
  // TODO: wire knownSymbols from venue instrument cache for orderbook/perp validation
  // TODO: wire tokenResolutions from venue token registry for swap/dex resolution
});

// ...
billingOutcome: 'not_implemented' as const,  // ← stub
requestId: null,                              // ← stub
```

### 1.2 `recommend-preset-transition.ts`

One TODO:

```ts
// Path B: symbol-first resolution — not yet supported without venue context.
// TODO: resolve venueFamily and instrumentKind from agent config when ToolContext exposes it.
```

### 1.3 `apply-preset-transition.ts`

Two TODOs/stubs:

```ts
// TODO: resolve current preset from agent metadata (agents table metadata.strategyPreset).
let oldPresetKey = 'unknown';  // ← hardcoded!

// Resolve open position count — stub until position repo is wired into ToolContext
const openPositionCount = 0;  // ← hardcoded!
```

---

## 2. What Needs to Change

### 2.1 Auto-Resolve venueFamily from Agent Config

**Problem:** The agent must manually specify `venueFamily` in every `get_market_preset_assessment` call. The agent already has a configured venue via its binding or technical config.

**Solution:** Extend `ToolContext` to expose venue resolution:

```ts
interface ToolContext {
  // ... existing fields ...

  /** Resolve the agent's primary venue family from its binding/technical config. */
  resolveVenueFamily?: () => Promise<string | null>;

  /** Resolve the agent's active style tier from its current preset. */
  resolveStyleTier?: () => Promise<'economy' | 'standard' | 'premium' | null>;

  /** Get the agent's current preset key. */
  getCurrentPresetKey?: () => Promise<string | null>;

  /** Get the agent's open position count. */
  getOpenPositionCount?: () => Promise<number>;
}
```

**Resolved:** All new methods are optional (`?`). Making them required would break every existing tool implementation and test that constructs a `ToolContext`. The assessment tools already handle missing context gracefully (returning structured errors).

**Implementation in worker/index.ts:** When constructing tool context for agent tools, wire these resolvers using the existing `AgentRepository`, `BotRepository`, and venue binding data already available in the worker.

### 2.2 Auto-Resolve styleTier from Active Preset

**Problem:** `styleTier` is hardcoded to `'standard'`. An agent on an `economy` or `premium` preset will get assessments for the wrong tier.

**Solution:** Resolve from the agent's active preset:
1. Read the agent's current preset key from `agents` table or `agentConfigOps`.
2. Map preset key to style tier. **Resolved:** Use a static config-driven map for Phase 1:
   ```yaml
   platformAssessor:
     presetTierMap:
       momentum_v1: standard
       scalper_v1: economy
       swing_v1: premium
   ```
   This is simple, explicit, and trivially testable. The preset catalog is small and changes infrequently. A dynamic reverse-lookup from the YAML catalog files can replace this later if the catalog grows.
3. If resolution fails, fall back to `'standard'` with a logged warning.

### 2.3 Wire knownSymbols for Orderbook/Perp Validation

**Problem:** `resolveAssessmentIdentity()` accepts `knownSymbols` for validating orderbook/perp symbols, but it's never passed — so any symbol is accepted without venue validation.

**Solution:** Use the existing `VenueInstrumentCache`:
1. The cache is already initialized in `index.ts` with `normalizeHyperliquidSymbol`, `normalizeBybitSymbol`, etc.
2. Expose a `getKnownSymbols(venueFamily: string): Set<string>` method on the cache (or via a helper).
3. Pass the set to `resolveAssessmentIdentity()`.
4. Cache lookup: `VenueInstrumentCache` already stores normalized symbols in Redis.

### 2.4 Wire tokenResolutions for Swap/Dex Resolution

**Problem:** `resolveAssessmentIdentity()` accepts `tokenResolutions` for swap/dex symbol→(network, address) mapping, but it's never passed — so swap/dex symbols cannot be resolved.

**Solution:** Use the existing token resolution infrastructure:
1. The worker already has `resolveSwapTokenData()` and `DexScreenerProvider` wired.
2. Build a `tokenResolutions` Map from the Discovery Redis cache (`market-intel:discovery:latest`) keyed by user-facing symbol → `{ network, address }`.
3. Pass the Map to `resolveAssessmentIdentity()`.

**Resolved:** The Discovery Redis cache has a 10-minute TTL. This is more than sufficient for token resolution — token addresses on a chain never change. If a newly listed token is not yet in the cache, resolution fails with `unknown_symbol`, which is correct behavior. The agent can retry after cache refresh. No lower TTL or direct-lookup fallback needed for Phase 1.

### 2.5 Resolve oldPresetKey in apply-preset-transition

**Problem:** `oldPresetKey` is hardcoded to `'unknown'`, making transition audit records incomplete.

**Solution:**
1. Query the agent's current preset from the `agents` table (`metadata.strategyPreset` or `unifiedConfig.allowedPresets`).
2. If the agent has a current preset, use it. If not (first-time setup), use `'none'` instead of `'unknown'`.

### 2.6 Resolve openPositionCount in apply-preset-transition

**Problem:** `openPositionCount` is hardcoded to `0`.

**Solution:**
1. Use `BotRepository.getOpenPositionsByCreator('agent', agentId)` (already used elsewhere in `agent.ts`).
2. Count the results.
3. Pass the count.

### 2.7 Billing Outcome in get-market-preset-assessment

The `billingOutcome: 'not_implemented'` stub is acceptable until Plan 007 wires billing. Keep it as-is — Plan 007 will replace it with real billing outcome data.

---

## 3. Files Changed

| File | Change |
|------|--------|
| `packages/domain/src/tool-schemas.ts` | Extend `ToolContext` interface with `resolveVenueFamily`, `resolveStyleTier`, `getCurrentPresetKey`, `getOpenPositionCount`. |
| `apps/worker/src/tools/get-market-preset-assessment.ts` | Use `ctx.resolveVenueFamily()` and `ctx.resolveStyleTier()` instead of requiring `venueFamily` and hardcoding `styleTier`. Wire `knownSymbols` and `tokenResolutions` via new context methods. |
| `apps/worker/src/tools/recommend-preset-transition.ts` | Enable symbol-first path B by resolving venueFamily from context. |
| `apps/worker/src/tools/apply-preset-transition.ts` | Use `ctx.getCurrentPresetKey()` and `ctx.getOpenPositionCount()` instead of hardcoded values. |
| `apps/worker/src/index.ts` | Wire the new ToolContext resolvers when constructing tool context. |
| `apps/worker/src/venue-instrument-cache.ts` | Expose `getKnownSymbols(venueFamily)` method if not already available. |

---

## 4. Dependencies

- Plans 008-009 should be implemented first — the tools need a working assessor to be useful.
- `VenueInstrumentCache` must be initialized with venue data.
- Discovery Redis cache must be populated for swap/dex token resolution.

---

## 5. Test Strategy

- **Unit tests:** Mock `ToolContext` resolvers. Verify:
  - `venueFamily` auto-resolved when not provided in params
  - `styleTier` resolved from agent preset
  - Symbol validation rejects unknown symbols when `knownSymbols` is wired
  - Swap/dex symbols resolve correctly when `tokenResolutions` is wired
  - `oldPresetKey` and `openPositionCount` are resolved from context
- **Integration tests:** Run tools against real DB with a seeded agent that has a configured venue, preset, and open positions.
- **No visual/browser testing needed.**

---

## 6. Completion Bar

- `get_market_preset_assessment` works without `venueFamily` param when agent has a configured venue.
- `styleTier` is resolved from agent's actual preset, not hardcoded to `'standard'`.
- Orderbook/perp symbols are validated against venue instrument cache.
- Swap/dex symbols are resolved to canonical `{network, address}` via token registry.
- `apply_preset_transition` records the actual `oldPresetKey` and `openPositionCount`.
- `recommend_preset_transition` symbol-first path works when venue context is available.
- `pnpm lint` and `pnpm build` pass.

---

## 7. Resolved Design Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | **ToolContext methods: all optional (`?`)** | Avoids breaking every existing tool and test. Assessment tools handle missing context gracefully. |
| 2 | **Preset→tier mapping: static YAML config map** | Simple, explicit, testable. Preset catalog is small. Dynamic reverse-lookup can replace later. |
| 3 | **`getKnownSymbols()`: expose from VenueInstrumentCache** | Data already in Redis. Thin wrapper — check if method exists, add if not. |
| 4 | **Token resolution freshness: 10-min cache TTL is fine** | Token addresses are permanent. Cache miss = `unknown_symbol` (correct behavior). |
