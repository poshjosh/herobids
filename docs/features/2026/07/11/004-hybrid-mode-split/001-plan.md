# 004 — Hybrid Mode Split: `intelligence` / `hybrid (mixed)` / `hybrid (scanner_gated)`

**Status:** Implemented  
**Created:** 2026-07-11  
**Source:** [Hybrid agent redesign decisions (revised)](../../06/22/002-hybrid-agent-redesign/000-decisions.md)

## Problem

Today, hybrid mode is implicitly derived: if an agent has both `intelligence` and
`technical` config, it is hybrid. There is no way to express the difference between:

1. **Mixed-wake hybrid** — scanner exists, but the LLM can still be triggered by
   `watch_threshold`, `discovery_delta`, or `regime_change` wakes. Full scout/judge
   tool-calling loop remains possible.
2. **Scanner-gated hybrid** — the LLM is invoked ONLY when the scanner produces
   entry or exit candidates. No other wake source triggers a trading LLM turn.
   Single-shot structured-output prompt only.

Evaluation data (2026-07-10) shows hybrid agents consuming nearly as many tokens as
intelligence-only agents, because non-scanner wake sources still punch through and
per-tick payloads remain large.

## Design

### Config model

Two new explicit fields on agents:

```
capabilityMode: 'intelligence' | 'hybrid'
hybridMode:     'mixed' | 'scanner_gated'   // only when capabilityMode = 'hybrid'
```

- `intelligence` — LLM-only agent. No technical scanner. Full scout/judge loop.
- `hybrid` / `mixed` — scanner + LLM. Scanner AND other wake sources may trigger
  LLM turns. Full scout/judge loop or hybrid evaluator depending on wake source.
- `hybrid` / `scanner_gated` — scanner + LLM. ONLY scanner events trigger trading
  LLM turns. Single-shot structured-output prompt. No tool-calling.

Reminders and user messages are unaffected by `scanner_gated` — those are not
trading turns.

### Runtime semantics

| | `intelligence` | `hybrid` / `mixed` | `hybrid` / `scanner_gated` |
|---|---|---|---|
| Scanner loop | No | Yes | Yes |
| Scheduled timer ticks | Yes (LLM may run) | Yes (no-wake guard) | Yes (no-wake guard) |
| Wake sources that trigger LLM | All | All | `scanner` only |
| LLM path | Scout/judge | Scout/judge or hybrid evaluator | Hybrid evaluator only |
| `discovery_delta` / `regime_change` | Wake | Wake or context-only | Context-only (no wake) |
| `watch_threshold` | Wake | Wake | Disabled for trading turns |
| Per-trade SL/TP | Yes | Yes | Yes (deterministic, no LLM) |
| Portfolio stop-loss | Yes | Yes | Yes (deterministic, no LLM) |
| `autonomousExit` | N/A | Optional | Recommended |

### Exit handling in scanner_gated mode

- The scanner evaluates open positions every cycle.
- If `autonomousExit: true` → scanner submits exits directly. No LLM involved.
- If `autonomousExit: false` → scanner marks `exitAdvisory` and emits a wake.
  The LLM is woken ONLY for that exit ratification, not for general reasoning.

### Migration

- Existing agents with `technical` config → `capabilityMode: 'hybrid'`, `hybridMode: 'mixed'`.
- Existing agents without `technical` config → `capabilityMode: 'intelligence'`.
- No data loss. Both modes preserve current behavior by default.

## Part A — Domain Schema (Phase 1) [DONE]

### Changes

| File | Action |
|------|--------|
| `packages/domain/src/config/schema.ts` | Add `CapabilityModeSchema`: `z.enum(['intelligence', 'hybrid'])` |
| `packages/domain/src/config/schema.ts` | Add `HybridModeSchema`: `z.enum(['mixed', 'scanner_gated'])` |
| `packages/domain/src/config/schema.ts` | Add both to `UnifiedAgentConfigSchema` |
| `packages/domain/src/config/schema.test.ts` | Validation tests for new enums |

### Validation

- `capabilityMode: 'hybrid'` with no `technical` config → reject
- `capabilityMode: 'intelligence'` with `hybridMode` set → reject
- `hybridMode` defaults to `'mixed'` when absent

## Part B — Database & Repository (Phase 2) [DONE]

### Changes

| File | Action |
|------|--------|
| `packages/db/src/schema/agents.ts` | Add `capabilityMode` and `hybridMode` columns (or JSONB fields) |
| `packages/db/src/agent-repository.ts` | Read/write new fields in `getUnifiedConfig` / `updateUnifiedConfig` |
| `packages/db/drizzle/` | Migration for new columns |

### Validation

- Existing agents migrate with correct defaults (see Migration section above)
- Repository round-trip preserves both fields

## Part C — API (Phase 3) [DONE]

### Changes

| File | Action |
|------|--------|
| `apps/api/src/routes/agents.ts` | Accept `capabilityMode` and `hybridMode` in POST/PATCH |
| `apps/api/src/routes/agents.test.ts` | Test validation and defaults |

### Validation

- POST with `capabilityMode: 'hybrid'` + no `technical` → 400
- PATCH `hybridMode: 'scanner_gated'` on an `intelligence` agent → 400

## Part D — Runtime (Phase 4) [DONE]

### Changes

| File | Action |
|------|--------|
| `apps/worker/src/agent.ts` | Read `capabilityMode` and `hybridMode` from config |
| `apps/worker/src/agent.ts` | Replace `hybridMode` boolean with enum-based gating |
| `apps/worker/src/agent.ts` | In `scanner_gated`: suppress non-scanner wake → LLM dispatch |
| `apps/worker/src/agent.ts` | In `scanner_gated`: route ALL trading turns through hybrid evaluator |
| `apps/worker/src/agent-trading-actor.ts` | Pass mode to scanner wake logic |
| `apps/worker/src/market-intelligence/monitor.ts` | In `scanner_gated`: emit `discovery_delta` and `regime_change` as context-only; skip `watch_threshold` wakes for trading |

### Validation

- `scanner_gated` agent: scanner signal → LLM tick fires (hybrid evaluator)
- `scanner_gated` agent: `watch_threshold` trigger → no LLM tick
- `scanner_gated` agent: `discovery_delta` → context-only, no wake
- `scanner_gated` agent: user message or reminder → still processed normally
- `mixed` agent: behavior unchanged from current hybrid

## Part E — Web UI (Phase 5) [DONE]

### Changes

| File | Action |
|------|--------|
| `apps/web/src/features/agents/agent-form-state.ts` | Replace `capabilityMode` union with new values |
| `apps/web/src/features/agents/agent-payloads.ts` | Send `capabilityMode` and `hybridMode` in payloads |
| `apps/web/src/features/agents/AgentFormBody.tsx` | Add `hybridMode` selector (visible when `capabilityMode === 'hybrid'`) |
| `apps/web/src/features/agents/AgentsPage.tsx` | Derive `capabilityMode` from config; wire `hybridMode` |
| `apps/web/src/features/agents/EditAgentModal.tsx` | Same as AgentsPage |
| `apps/web/src/features/agents/WakeSourceSection.tsx` | Hide wake sources when `scanner_gated` (scanner is implicit) |

### UI labels

- `intelligence` → "Intelligence"
- `hybrid` + `mixed` → "Hybrid (Mixed Wake)"
- `hybrid` + `scanner_gated` → "Hybrid (Scanner-Gated)"

## Part F — Remove Dead Capability Value (Phase 6) [DONE]

The current `capabilityMode` type includes `'technical'` from the original
three-value model. This value is unused at runtime and was already flagged as
invalid in the E2E race-condition bug fix.

### Changes

| File | Action |
|------|--------|
| `apps/web/src/features/agents/agent-form-state.ts` | Remove `'technical'` from `CapabilityMode` |
| `apps/web/src/features/agents/agent-payloads.ts` | Remove `'technical'` branch |
| `apps/web/src/features/agents/CapabilitySelector.tsx` | Remove if present |

## Testing Strategy

| Phase | Unit Tests | Integration Tests |
|-------|-----------|-------------------|
| A | Schema validation, enum values | — |
| B | Repository read/write | DB migration round-trip |
| C | API validation, error cases | POST/PATCH acceptance |
| D | Mode gating, wake suppression | `scanner_gated` full flow |
| E | Form state, payload construction | E2E: create/edit agent with each mode |
| F | Type checks, dead code removal | Existing E2E still pass |

## Acceptance Criteria

1. `capabilityMode: 'intelligence'` agent behaves identically to current intelligence-only agents.
2. `capabilityMode: 'hybrid'` / `hybridMode: 'mixed'` agent behaves identically to current hybrid agents.
3. `capabilityMode: 'hybrid'` / `hybridMode: 'scanner_gated'` agent:
   - Only wakes the LLM for scanner entry signals and exit advisories.
   - Does not wake the LLM for `watch_threshold`, `discovery_delta`, or `regime_change`.
   - Uses the single-shot hybrid evaluator for all trading turns.
   - Still processes user messages and reminders normally.
4. Deterministic exits (per-trade SL/TP, portfolio stop-loss) work in all modes.
5. Migration sets correct defaults for all existing agents.
6. `pnpm lint` and `pnpm test` pass.

## Outstanding Issues

### [Part A] Domain Schema

**MEDIUM:**
1. **[RESOLVED — comment added to schema.ts]** **`hybridMode` default mismatch between plan and implementation.** The plan says `hybridMode` defaults to `'mixed'` when absent, but the schema uses `.optional()` with no `.default('mixed')` because `.default()` would break intelligence agents (Zod applies defaults before `superRefine`). The `'mixed'` default must be applied at the API/repository layer (Parts B/C). The schema should document this tradeoff with a comment.
2. **Missing test: hybrid agent without explicit `hybridMode`.** No test verifies that `{ capabilityMode: 'hybrid', technical: {...} }` parses successfully with `hybridMode: undefined`. This contract needs to be explicit so Part D implementers know to fill `'mixed'` when absent.

**LOW:**
3. **Redundant migration test.** The test "accepts existing agent with technical config (migration)" duplicates the same code path as "accepts capabilityMode 'hybrid' with hybridMode 'mixed'". Consider varying the migration test to omit `hybridMode` to test the undefined-default path.
4. **Custom error messages use plain English, not dot-string codes.** Consistent with existing codebase pattern — no action needed.

### [Part B] Database & Repository

**MEDIUM:**
1. **[RESOLVED — 4 tests added to agent-repository.test.ts]** **No test coverage for `updateUnifiedConfig` hybridMode stamping.** The 6 new tests only cover `getUnifiedConfig`. The `updateUnifiedConfig` write-path stamping (HIGH-2 fix) has no test coverage. Add 2-3 tests mocking `db.update` to verify: hybrid agent without `hybridMode` gets `'mixed'` stamped; explicit `hybridMode: 'scanner_gated'` preserved; intelligence agent gets no `hybridMode` injected.
2. **`CapabilityMode` / `HybridMode` types and schemas not re-exported from domain barrel (`config/index.ts`).** Parts C (API) and D (Runtime) will need standalone type imports. Currently only available via `UnifiedAgentConfig` extraction. Add barrel exports to `packages/domain/src/config/index.ts`.

**LOW:**
3. **Domain package dist requires rebuild after Part A changes.** `tsc --noEmit` in dependent packages fails until domain is rebuilt. CI should run `pnpm build` before `pnpm lint`.
4. **`as UnifiedAgentConfig` cast on helper result is type-unsafe.** Follows pre-existing codebase pattern for JSONB access. Consider `safeParse` guard in future hardening pass.

### [Part C] API

**MEDIUM:**
1. **[RESOLVED — test added]** **No test for POST default `capabilityMode: 'intelligence'` when field omitted.** Verify that omitting `capabilityMode` defaults to `'intelligence'` in inserted values.
2. **[RESOLVED — test added]** **No test for PATCH clearing `capabilityMode` (setting to `null`).** Verify that setting `capabilityMode: null` on a hybrid agent also clears `hybridMode`.

**LOW:**
3. **Repeated `as Record<string, unknown>` casts in PATCH handler.** Extract a local typed variable to reduce verbosity.
4. **PATCH validation occurs after merge mutations.** Cross-field validation could run before mutations for defense-in-depth (benign since DB tx not yet started).

### [Part D] Runtime

**MEDIUM:**
1. **[RESOLVED — 3 tests added + isAgentScannerGated extracted]** **No test coverage for market monitor scanner_gated changes (`monitor.ts`).** `isAgentScannerGated` and the three behavioral changes (skip watch_threshold, context-only discovery_delta, context-only regime_change) have zero test coverage.
2. **[RESOLVED — extracted to apps/worker/src/redis-keys.ts]** **Duplicated Redis key format `agent:scanner_gated:${agentId}`** hardcoded identically in `agent.ts` and `monitor.ts`. Extract to a shared constant.

**LOW:**
3. **Redundant test case in `hybrid-agent-evaluator.test.ts`** — `scanner_gated + no wake signal → false` duplicates the generic `no wake signal` test.
4. **`watch_threshold` scanner_gated check uses inline `isAgentScannerGated`** without pre-computation (unlike discovery_delta/regime_change). O(agents) loop makes this fine, but pattern inconsistent.
5. **Scanner_gated Redis flag set before full startup completion.** Flag lives up to 24h TTL if process crashes mid-startup; `isActive` guards on monitor side make this harmless.

### [Part E] Web UI

**MEDIUM:**
1. **Hardcoded English strings for hybrid mode labels in review row** (`AgentsPage.tsx`). Should use i18n (`intl.formatMessage`) for consistency with all other review row values.
2. **`CapabilitySelector` i18n keys still use `'both'` prefix** (`agents.capability.both.label`). Semantically stale but functionally correct. Rename to `agents.capability.hybrid.*` in a follow-up i18n cleanup.
3. **`hybridMode` defaults to `'mixed'` for intelligence agents in form state.** Invisible in UI (selector gated behind `capabilityMode === 'hybrid'`), but carries a misleading value. Default to `'mixed'` only when `capabilityMode === 'hybrid'`.

**LOW:**
4. **Inline styles in hybrid mode selector duplicate `CapabilitySelector` pattern.** Extract a reusable `ModeToggleGroup` component or share a style constant.
5. **`hybridMode` sent as `null` for non-hybrid agents in update payload.** API should guard against this (Part C should handle it).

**CRITICAL (fixed):**
- Removed dead `=== 'both'` guards from `form-validation.ts`, `AgentsPage.tsx`, `EditAgentModal.tsx`, `agent-payloads.ts`
- Removed unused `showTechnical` variable from `form-validation.ts`
- Updated `form-validation.test.ts` to use `'hybrid'` instead of `'both'`

### [Part F] Remove Dead Capability Value

**LOW:**
1. **`deriveCapabilityMode` function only used in its own test file.** Consider removing the function and tests since it's dead code — actual CD is derived inline in `AgentsPage.tsx` and `EditAgentModal.tsx`.
2. **`agent-payloads.test.ts` had 3 tests using `'technical'` mode.** Updated to use `'hybrid'` with adjusted assertions. The "technical-only" test concept doesn't exist in the new model.
