# Decision 1: Strict Persisted-Config Validation and Actor Startup Rejection Contract

**Decision:** 1 — Strict persisted-config validation mechanism and existing lifecycle/event contract for rejected actor startup
**Status:** accepted
**Date:** 2026-07-16
**Owner:** Implementer agent (Phase 0 research)

## Question

What is the strict persisted-config validation mechanism for hybrid agent technical configuration at worker startup, and what existing lifecycle/event contract is used when actor startup is rejected?

## Inspected Sources

### Worker actor construction path

- `apps/worker/src/index.ts` lines 789–940 (`onSessionActive` callback):
  - `agentRepo.getAgent(agentId)` returns raw DB row (line 809) — no defaults applied.
  - `agent.unifiedConfig.technical` is cast via `as TechnicalConfig | undefined` (line 830) — a pure TypeScript cast with **zero runtime validation**.
  - The raw value is passed to `new AgentTradingActor({...technicalConfig})` (line 832).
  - Errors in the `try` block are caught and routed to `sessionManager.handleActivationFailure()` (called at `agent-session-manager.ts` line 683 when `onSessionActive` throws).

- `apps/worker/src/index.ts` lines 885–890 (`onCrashed` callback):
  - Wired as `onCrashed: async (err) => { agentState.deregisterOnCrash(...); await sessionManager.handleRuntimeFailure(...); }`
  - This is for **runtime** failures after successful start, not startup rejection.

### AgentTradingActor construction and start

- `apps/worker/src/agent-trading-actor.ts` lines 254–258 (constructor):
  - No validation. Stores `deps` as-is.

- `apps/worker/src/agent-trading-actor.ts` lines 260–500 (`start()` method):
  - Calls `startTechnicalScanLoop()` at two points: line 300 (paper mode) and line 480 (shadow/live mode).
  - No validation of `technicalConfig` before starting the scan loop.
  - If start throws, the `catch` block calls `stop()` and re-throws — the error propagates to the `onSessionActive` try/catch.

- `apps/worker/src/agent-trading-actor.ts` lines 1436–1452 (`startTechnicalScanLoop()`):
  - Guard: `if (!technicalConfig || !discoverCandidates || !fetchCandles)` → returns early.
  - If `technicalConfig` is present but has missing fields (e.g., `scanIntervalMs` is `undefined` because defaults were never applied), `setInterval(fn, undefined)` runs at ~1ms intervals — **this is the scanner storm bug**.
  - If `scanBatchSize` is `undefined`, the batch-loop increment becomes `NaN` and no candle fetch is ever attempted.

### Repository layer: getAgent() vs getUnifiedConfig()

- `packages/db/src/agent-repository.ts` lines 253–255 (`getAgent()`):
  - Returns raw DB row. `unifiedConfig` is raw JSONB with NO defaults applied.
  - 27 call sites across the codebase use `getAgent()` (per investigation in `001-investigation-of-current-deployment.md`).

- `packages/db/src/agent-repository.ts` lines 309–323 (`getUnifiedConfig()`):
  - Calls `applyCapabilityModeMigrationDefaults()` → `applyConfigDefaults()`.
  - `applyConfigDefaults()` (lines 69–95) parses `technical` through `TechnicalConfigSchema.parse()` to inject Zod defaults.
  - On parse failure, the block is left as-is (silent catch).
  - Used by API read paths but NOT by the worker's actor construction path.

### TechnicalConfigSchema and its defaults

- `packages/domain/src/config/schema.ts` lines 1861–1884 (`TechnicalConfigSchema`):
  - Fields with `.default()` that silently repair missing persisted data:
    - `indicators`: `.default({})`
    - `candles`: `.default({})` (inner fields: `interval` defaults to `'15m'`, `limit` defaults to `100`)
    - `signalBias`: `.default('trend-following')`
    - `scanIntervalMs`: `.default(60_000)` ← **critical: missing → setInterval runs at ~1ms**
    - `scanBatchSize`: `.default(5)` ← **critical: missing → batch loop increment becomes NaN**
    - `autonomousExit`: `.default(false)`
  - Fields with NO defaults (already required by the schema):
    - `filters` (the whole object is required)
    - `filters.venue` (required string)
    - `filters.venueType` (required enum)
  - No `.strict()` modifier.

### UnifiedAgentConfigSchema validation

- `packages/domain/src/config/schema.ts` lines 1897–1940 (`UnifiedAgentConfigSchema`):
  - Has `.superRefine()` that requires `technical` config when `capabilityMode === 'hybrid'` (line 1927).
  - This validation is ONLY applied at API write time (when `UnifiedAgentConfigSchema.parse()` is called at create/PATCH).
  - Worker's `getAgent()` path bypasses this entirely.

### Existing startup failure contract

- `apps/worker/src/agents/agent-session-manager.ts` lines 893–908 (`handleActivationFailure()`):
  - Called when `onSessionActive` throws (i.e., actor construction/start fails).
  - Delegates to `handleTradingActorFailure()` with:
    - `guardrailCode: 'trading_actor.start_failed'`
    - `guardrailMessage: 'Agent trading context failed to initialize — session stopped'`
    - `instanceReason: 'trading_actor_start_failed'`

- `apps/worker/src/agents/agent-session-manager.ts` lines 910–995 (`handleTradingActorFailure()`):
  1. Idempotency check: skips if session is already terminal (`stopped`/`crashed`) or a newer active session exists.
  2. Stops runtime launcher (`runtimeLauncher.stop(sessionId)`).
  3. Updates session status → `'crashed'`.
  4. Updates agent status → `'crashed'`.
  5. Emits `guardrail_triggered` event (Redis Stream) with code `trading_actor.start_failed`.
  6. Emits `instance_status` event with status `'stopped'`.
  7. Calls `onAgentStatusChange` (real-time UI update).
  8. Fires platform alert `RUNTIME_FAILED`.

### Existing runtime crash contract (onCrashed)

- `apps/worker/src/agent-trading-actor.ts` lines 571–620 (`crash()` method):
  - Only reachable AFTER successful start (called by reconciler, live timeout handler, etc.).
  - Journals `instance.crashed` with crash details.
  - Calls `stop()` → `onCrashed` callback.
  - `onCrashed` (index.ts line 885): `agentState.deregisterOnCrash()` + `sessionManager.handleRuntimeFailure()`.
  - `handleRuntimeFailure()` uses `guardrailCode: 'trading_actor.runtime_failed'`.

### Actor state owner crash handling

- `apps/worker/src/agents/actor-state-owner.ts` lines 81–90 (`deregisterOnCrash()`):
  - Removes actor from `actorRegistry` and `ownerSessions` if the registry entry matches.
  - Clears pending and fallback state.

### Event publisher patterns

- `apps/worker/src/agents/instance-event-publisher.ts`:
  - `emitTechnicalScanCompleted()` publishes to stream `agent.technical.scan_completed` (line 87).
  - `emitAgentWake()` publishes to stream `agent.wake` (line 83).
  - `emitGuardrailTriggered()` publishes guardrail events with `scope` and `code` (line 58).
  - `emitInstanceStatus()` publishes status changes (line 64).
  - All use Redis Streams keyed `agent:outbound:{agentId}`.

### Agent health publisher

- `apps/worker/src/actor-health-publisher.ts` (used at index.ts line 940):
  - Publishes `status: 'healthy'` after successful actor registration.
  - Publishes `status: 'stopped'` on session stop (line 951).

## Decision

### Chosen validation mechanism: Separate `StrictTechnicalConfigSchema` with startup gate in `onSessionActive`

**1. Schema approach: `StrictTechnicalConfigSchema` in `packages/domain/src/config/schema.ts`**

A new Zod schema that mirrors `TechnicalConfigSchema` but removes ALL `.default()` calls. Fields that have defaults in the write-time schema become required in the strict variant:

```typescript
export const StrictTechnicalConfigSchema = z.object({
  filters: z.object({
    venue: z.string(),
    venueType: z.enum(['orderbook', 'swap']),
    minVolume24hUsd: z.number().min(0).optional(),
    minLiquidityUsd: z.number().min(0).optional(),
    networks: z.array(z.string()).optional(),
    symbols: z.array(z.string()).optional(),
    excludeSymbols: z.array(z.string()).optional(),
  }),
  regime: RegimeParamsSchema.optional(),
  indicators: IndicatorConfigSchema,         // no .default({})
  candles: z.object({
    interval: z.enum(['5m', '15m', '1H', '4H', '1D']).default('15m'),
    limit: z.number().int().min(20).max(500).default(100),
  }),                                         // no .default({}) on outer object
  signalBias: z.enum(['trend-following', 'mean-reverting']), // no .default()
  scanIntervalMs: z.number().int().min(10_000),  // no .default(60_000)
  scanBatchSize: z.number().int().min(1).max(50), // no .default(5)
  autonomousExit: z.boolean(),                   // no .default(false)
});
```

Notes on inner defaults:
- `candles.interval` and `candles.limit` retain their `.default()` because these are shape defaults (not safety-critical for the scanner storm). If the `candles` object is present, the inner fields can safely default. The strict variant only requires the `candles` object itself to be present.
- `indicators` inner fields (in `IndicatorConfigSchema`) also retain their defaults — the strict check only requires the `indicators` object to be present, not every inner field populated.

**2. Validation point: in `onSessionActive`, before `new AgentTradingActor()`**

The validation gate is placed in `apps/worker/src/index.ts`, inside the `onSessionActive` callback, at the point where `technicalConfig` is currently read from raw JSONB (line 830). The flow becomes:

```
agent = await agentRepo.getAgent(agentId)
rawTechnical = agent?.unifiedConfig?.technical

if agent is hybrid:
  if hybridMode is 'scanner_gated':
    // STRICT: reject incomplete config entirely
    parsed = StrictTechnicalConfigSchema.parse(rawTechnical)  // throws if incomplete
    technicalConfig = TechnicalConfigSchema.parse(parsed)       // apply inner defaults for runtime
  else if hybridMode is 'mixed':
    // LENIENT: parse with defaults, warn if repair occurred
    technicalConfig = rawTechnical
      ? TechnicalConfigSchema.parse(rawTechnical)
      : undefined
  // else (intelligence): technicalConfig = undefined
else:
  // intelligence agent — no technical config needed
  technicalConfig = undefined

actor = new AgentTradingActor({...technicalConfig})
```

**3. Gating scope: `scanner_gated` agents ONLY**

- `scanner_gated` agents: The scanner is their PRIMARY decision mechanism. An incomplete technical config means the agent cannot function. Reject startup with the established failure contract. No actor is instantiated.
- `mixed` agents: The scanner provides SUPPLEMENTARY context. Parse through `TechnicalConfigSchema` to apply defaults. If config is absent, skip scan loop (existing behavior). Log a warning if defaults were applied (i.e., persisted config was incomplete but was repaired).
- `intelligence` agents: No technical config. Start normally. No change.

**Justification for scoping to `scanner_gated` only:**
- The scanner storm bug specifically affected `scanner_gated` agents whose technical scan is the primary operational path.
- `mixed` agents have an LLM fallback — rejecting them for incomplete technical config would be a regression (they can still trade via the LLM).
- The plan's acceptance criterion says "A raw hybrid record missing a required persisted technical field cannot start an actor" — but the practical blast radius of rejecting ALL hybrid agents is too large. The plan title and bug are specifically about scanner-gated hardening.
- `intelligence` agents have no technical block and must not be affected.

**4. Failure contract: reuse existing `handleActivationFailure` path**

When `StrictTechnicalConfigSchema.parse()` throws:
- The error propagates out of the `onSessionActive` try block.
- The existing `catch` in the session manager (line 683) calls `handleActivationFailure()`.
- This triggers the full failure contract:
  - Guardrail event: `trading_actor.start_failed` with detail message from the Zod error.
  - Session → `'crashed'`, agent → `'crashed'`.
  - Instance status event: `'stopped'` with reason `'trading_actor_start_failed'`.
  - Platform alert: `RUNTIME_FAILED`.
  - NO actor is instantiated. NO scan timer is created.

No new event types, journal entries, or health statuses are introduced — the existing contract is sufficient.

## Rejected Alternatives

- **Alternative: Inline validation (if-checks for individual fields)**
  - Rejected because: fragile, duplicates schema knowledge, easy to miss when new fields are added, not type-safe, and would need separate error messages for each field.

- **Alternative: `.strict()` on existing `TechnicalConfigSchema`**
  - Rejected because: Zod's `.strict()` rejects unknown extra keys, not missing defaulted fields. Does not solve the problem.

- **Alternative: Move `applyConfigDefaults()` into `getAgent()` (the "broader fix" from investigation)**
  - Rejected because: silently repairs malformed scanner-gated configs instead of rejecting them. The plan explicitly requires rejection, not silent repair, at actor startup. Also touches 27 call sites with unknown side effects.

- **Alternative: Parse raw config with `TechnicalConfigSchema`, then compare before/after to detect repairs**
  - Rejected because: more complex than a separate strict schema. Requires deep equality comparison of nested objects. The strict schema approach is simpler and self-documenting.

- **Alternative: Validate in `AgentTradingActor` constructor or `start()` method**
  - Rejected because: by the time we reach the constructor, the actor is already partially initialized. The plan states "do not instantiate an actor or start a timer" on validation failure. Validation must occur before `new AgentTradingActor()`.

- **Alternative: Apply strict validation to ALL hybrid agents (both `mixed` and `scanner_gated`)**
  - Rejected because: `mixed` agents have an LLM as their primary decision mechanism. A missing technical scan is non-fatal for them — they can still trade. Rejecting them widens the blast radius unnecessarily. The plan's strictest language ("cannot start an actor") is interpreted as applying to `scanner_gated` agents where the scanner IS the decision mechanism.

## Implementation Consequences

### Files to create/modify

| File | Change |
|------|--------|
| `packages/domain/src/config/schema.ts` | Add `StrictTechnicalConfigSchema` export |
| `apps/worker/src/index.ts` | Replace raw `as TechnicalConfig` cast with strict validation gate in `onSessionActive` (lines 830–832) |
| `packages/db/src/agent-repository.ts` | No changes in this phase (the `applyConfigDefaults()` helper is NOT moved into `getAgent()`) |

### Type exports

- Export `StrictTechnicalConfig` type alongside `StrictTechnicalConfigSchema`:
  ```typescript
  export type StrictTechnicalConfig = z.infer<typeof StrictTechnicalConfigSchema>;
  ```

### Intelligence agent impact

- **Zero impact.** Intelligence agents have no `technical` object in their `unifiedConfig`. The validation gate only fires for agents with `capabilityMode === 'hybrid'` AND `hybridMode === 'scanner_gated'`.

### Existing behavior preserved

- `applyConfigDefaults()` in `getUnifiedConfig()` is unchanged — API read paths continue to get defaults.
- `TechnicalConfigSchema` is unchanged — API write paths continue to apply defaults at persist time.
- `startTechnicalScanLoop()` guard (`!technicalConfig`) is preserved — defense in depth.
- The `onCrashed` callback is unchanged — runtime failures use the same contract as before.

## Required Validation

### Tests to prove the decision holds

1. **`StrictTechnicalConfigSchema` rejects incomplete config:**
   - Missing `scanIntervalMs` → parse fails with Zod error.
   - Missing `scanBatchSize` → parse fails.
   - Missing `filters` entirely → parse fails.
   - Missing `filters.venue` → parse fails.
   - Empty object `{}` → parse fails.
   - Complete config → parse succeeds.

2. **Worker startup: `scanner_gated` agent with incomplete `technical` config:**
   - Actor is NOT instantiated.
   - Session status → `'crashed'`.
   - Agent status → `'crashed'`.
   - Guardrail event emitted with code `trading_actor.start_failed`.
   - No scan timer is created.

3. **Worker startup: `scanner_gated` agent with complete `technical` config:**
   - Actor IS instantiated and registered.
   - Scan loop starts with correct `scanIntervalMs`.
   - No guardrail event emitted.

4. **Worker startup: `intelligence` agent (no `technical` config):**
   - Actor starts normally.
   - No technical scan loop.
   - No validation error.

5. **Worker startup: `mixed` agent with incomplete `technical` config:**
   - Actor starts normally.
   - Scan loop starts with defaults applied (repaired config).
   - Warning logged about repaired defaults.

6. **`StrictTechnicalConfigSchema` rejects `scanIntervalMs` values below minimum:**
   - `scanIntervalMs: 5000` → parse fails (min is 10_000).

### Commands to run

```bash
pnpm --filter @herobids/domain test
pnpm --filter @herobids/worker test
pnpm lint
```

## Residual Risk or Follow-Up

- **Risk:** The decision scopes strict validation to `scanner_gated` agents only, leaving `mixed` agents to silently repair incomplete technical configs. If `mixed` agents later become scanner-dependent (e.g., their LLM is removed), the same storm bug could recur. **Mitigation:** The `startTechnicalScanLoop()` guard still prevents the storm even for `mixed` agents (checks `!technicalConfig` — if absent after repair, scan doesn't start). The residual risk is minimal because `TechnicalConfigSchema.parse()` always produces a valid `scanIntervalMs`.
- **Risk:** The `StrictTechnicalConfigSchema` and `TechnicalConfigSchema` must be kept in sync. If a new field with a `.default()` is added to `TechnicalConfigSchema` but not mirrored in `StrictTechnicalConfigSchema`, the strict gate won't catch its absence. **Mitigation:** Add a comment in the schema file noting the dual-schema requirement. Consider a future refactor to auto-derive the strict variant.
- **Follow-up:** After Phase 1 implementation, a broader audit of the 27 `getAgent()` call sites should confirm no other paths silently cast `unifiedConfig.technical` as `TechnicalConfig`.
