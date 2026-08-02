# 01 - Execution Mode Canonicalization Plan

**Status:** Proposed
**Created:** 2026-08-02

## Purpose

Fix the execution-mode regression and remove ambiguity across UI, API, scripts, and persisted agent config.

Two failures are currently visible:

1. frontend agent creation can send `executionDefaults.mode = 'test'`, but the API schema only accepts `'paper' | 'shadow' | 'live'`
2. some trading agents created by `scripts/shell/run/create-agents.sh` persist `executionDefaults = null`, so the app shows execution mode as `Not set`

## Key Decision

**No backward compatibility.**

We will treat `'paper' | 'shadow' | 'live'` as the only valid canonical execution modes at the API and persistence layers.

Consequences:

- `'test'` is **not** a persisted value
- `'test'` is **not** an API contract value
- trading agents must never persist `executionDefaults = null`
- existing bad data (`null` execution defaults for trading agents) will be repaired, not preserved
- all callers (frontend, scripts, tests, tooling) must send canonical values

## Problem Statement

### A. Frontend/API contract drift

The frontend form currently models execution mode as a user-facing abstraction (`'test' | 'live'`), but the create/update payload writes that value directly into canonical `executionDefaults.mode`.

The API schema validates canonical execution defaults before any route-level normalization logic runs, so `'test'` is rejected by Zod.

### B. Persisted null execution defaults

The regular agent creation script omits `executionDefaults` entirely. The API currently persists that omission as `null` even for trading-capable agents.

The worker tolerates this by defaulting runtime behavior to `'paper'`, but the web app reads the DB value and correctly displays `Not set`.

This creates a split-brain state:

- runtime behaves as if mode is set
- persisted config says mode is unset
- UI reflects persisted config, not runtime fallback

## Locked Decisions

1. **Canonical wire/storage contract:** only `'paper' | 'shadow' | 'live'` are valid beyond the UI boundary.
2. **No alias persistence:** `'test'` remains, at most, a UI label/abstraction.
3. **Trading agents require persisted execution defaults:** a trading-capable agent cannot exist with `executionDefaults.mode` absent.
4. **Data repair over compatibility:** existing trading rows with `executionDefaults = null` will be backfilled to a concrete mode.
5. **Prefer loud failure:** callers that still send non-canonical values after this cleanup should fail clearly.

## Target End State

### Canonical invariants

- every trading-capable agent has `executionDefaults = { mode: 'paper' | 'shadow' | 'live', ... }`
- non-trading agents may omit `executionDefaults` or store `null`
- no route persists `'test'`
- no script or frontend payload sends `'test'` to the API
- the UI never shows `Not set` for trading agents unless the row is invalid and unrepaired

### User-facing semantics

The UI may still present simple language such as:

- `Test mode`
- `Live mode`

But that is only presentation. The persisted/API contract stays concrete:

- `paper` = simulated, no venue-backed execution
- `shadow` = venue-backed simulation
- `live` = real execution

If product wants a 2-option UI (`test` vs `live`), the UI must resolve `test` to `paper` or `shadow` before API submission.

## Recommended Approach

## 1. Tighten the API contract around canonical values

Keep `ExecutionDefaultsSchema` canonical.

Do **not** widen it to accept `'test'`.

Instead, make the create/update flows operate on canonical `executionDefaults` only. Any user-facing abstraction must be resolved before schema validation.

## 2. Move `test` resolution to the client boundary

The web form currently owns the `'test' | 'live'` abstraction. It should translate that abstraction into a concrete canonical mode before building the request payload.

Resolution rule:

- `test` + trading connection present → `shadow`
- `test` + no trading connection present → `paper`
- `live` → `live`

This keeps the public write contract strict and prevents alias leakage into API/domain code.

## 3. Make execution defaults mandatory for trading agent creation

For trading-capable agents, the API should ensure a concrete execution mode is persisted.

Given the no-backward-compat decision, the desired end state is:

- if caller omits `executionDefaults` for a trading-capable create request, reject the request, **or**
- temporarily synthesize a canonical default during the cleanup transition, then remove that fallback once all callers are updated

Recommended rollout for this repo:

1. update all first-party callers first
2. then make omission a validation error for trading-capable creates/updates where mode must be explicit

This avoids silently creating more incomplete rows.

## 4. Repair existing bad data

Backfill all existing trading-capable agents whose `executionDefaults` is null or whose `executionDefaults.mode` is missing.

Backfill rule:

- has active/granted trading connection → `shadow`
- no trading connection → `paper`

This must be a one-time data repair step, not a permanent runtime crutch.

## Work Packages

### WP1 — Inventory and classify execution-mode surfaces  **[DONE]**

Audit and update all places that read, write, derive, or display execution mode:

- `apps/web/src/features/agents/*`
- `apps/api/src/routes/agents.ts`
- `apps/api/src/routes/agent-config-helpers.ts`
- `packages/domain/src/config/schema.ts`
- `scripts/shell/run/create-agents.sh`
- `scripts/shell/run/create-eval-agents.sh`
- tests, fixtures, docs, seeded payloads

Output of this step:

- list of all first-party callers that still send `'test'`
- list of all callers that omit `executionDefaults`
- list of all places that treat missing execution mode as acceptable for trading agents

### WP2 — Canonicalize frontend payload building  **[DONE]**

Update agent create/edit payload builders so that they send canonical execution modes only.

Expected behavior:

- user-facing `test` selection resolves to `paper` or `shadow`
- payload always sends `executionDefaults.mode` for trading-capable agents
- legacy top-level `executionMode` payload remnants are removed if they are no longer used

Also update frontend tests to assert canonical payloads.

### WP3 — Tighten API validation and persistence  **[DONE]**

Refactor create/update agent routes so trading-capable agents always persist a concrete canonical execution mode.

Specific goals:

- remove any hidden dependence on post-parse alias handling for `'test'`
- reject non-canonical `executionDefaults.mode`
- reject or explicitly normalize missing trading execution defaults during the transition
- persist resolved canonical execution defaults, never `null`, for trading-capable agents
- preserve `null` only for genuinely non-trading agents

Because backward compatibility is not required, prefer deletion/simplification over carrying both old and new paths.

### WP4 — Repair existing agent data  **[PENDING]**

Add and run a repair path for existing agents with broken or missing execution defaults.

Scope:

- local dev DB
- any shared dev/staging DB if applicable
- production only if affected and approved operationally

The repair can be implemented as either:

- a migration-like one-off script, or
- a targeted admin/ops script

Requirements:

- only touches trading-capable agents with missing/invalid execution mode
- logs before/after counts
- is idempotent

### WP5 — Update first-party scripts and fixtures  **[PENDING]**

Update `scripts/shell/run/create-agents.sh` so all created trading agents send explicit canonical `executionDefaults.mode`.

Review all other scripts/fixtures for the same issue.

Expected result:

- no first-party agent creation path can create a trading agent with unset execution mode

### WP6 — Align UI display semantics  **[PENDING]**

Ensure display code treats persisted canonical values consistently:

- `paper` and `shadow` may both display as `Test mode` if product wants a simplified label
- detail views may still show the concrete underlying mode if useful
- `Not set` should be reserved for non-trading or invalid/unrepaired rows only

This is a presentation cleanup, not a contract change.

### WP7 — Test coverage and regression guards  **[PENDING]**

Add regression coverage for:

1. frontend create payload sends `paper`/`shadow`/`live`, never `test`
2. trading create route persists concrete `executionDefaults`
3. trading update route cannot regress persisted mode to null
4. `create-agents.sh`-equivalent payloads produce persisted canonical execution mode
5. repaired legacy rows render correctly in the UI

## Migration / Cleanup Strategy

Because backward compatibility is not required, prefer a short, clean transition:

1. update all first-party callers to canonical mode values
2. tighten API route logic to require/persist canonical mode for trading agents
3. run data repair for existing bad rows
4. remove dead compatibility logic that assumes `'test'` may arrive at the canonical schema boundary

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Frontend still sends `'test'` after backend tightening | update frontend payload builders first; add regression tests |
| Hidden scripts/tests still omit `executionDefaults` | inventory all first-party creation paths in WP1; fail loudly after cleanup |
| Existing agents continue showing `Not set` after code fix | include explicit data repair step; do not rely on runtime fallback |
| Over-repairing non-trading agents | scope repair to trading-capable agents only |
| Ambiguity between `paper` and `shadow` in simplified UI | keep concrete persisted mode; collapse only at presentation layer if desired |

## Acceptance Criteria

1. Creating a trading agent from the frontend no longer sends `'test'` to the API.
2. The API persists only canonical execution modes: `'paper' | 'shadow' | 'live'`.
3. No trading-capable agent created by first-party tooling persists `executionDefaults = null`.
4. Existing broken trading agents are repaired to a concrete mode.
5. The app no longer shows `Not set` for repaired/valid trading agents.
6. Regression tests cover both the frontend alias issue and the script-created-agent issue.
7. Dead compatibility code for legacy ambiguous execution-mode handling is reduced or removed.

## Out of Scope

- changing venue capability semantics beyond what is needed for canonical mode persistence
- redesigning authorization mode
- introducing new execution modes
- preserving compatibility for third-party callers still sending legacy/ambiguous payloads

## Notes for Implementer

- The current worker fallback to `'paper'` is useful as a defensive runtime safeguard, but it must not be the primary source of truth for persisted trading-agent config.
- If a 2-option UI remains desirable, keep that abstraction in the UI only.
- Prefer simplifying the write contract over adding more alias-aware server logic.
- Any code path that can create a trading agent should be considered incomplete unless it writes explicit canonical execution defaults.

---

## Outstanding Issues

### WP2 — Canonicalize frontend payload building

| # | Priority | Description |
|---|----------|-------------|
| M1 | MEDIUM | Asymmetric gating between create/update — create uses `includeIntelligence && requiresTradingSetup`, update uses `includeIntelligence && hasTradingCapability`. Unified already in current implementation. |
| M2 | MEDIUM | `executionDefaults` object always created on update path, even when mode is null. Fixed: now conditionally included when mode is non-null. |
| M3 | LOW | `UpdateAgentPayloadInput.executionMode` typed as `string` → narrowed to `'test' | 'live' | 'paper' | 'shadow' | ''` |

### WP3 — Tighten API validation and persistence

| # | Priority | Description |
|---|----------|-------------|
| H1 | HIGH | `agent-interactivity.ts` PATCH always persisted `executionDefaults.mode: 'paper'` even for non-trading agents. **FIXED** — now preserves existing executionDefaults. |
| M1 | MEDIUM | Stale `executionMode: 'test'` in integration test stub — weak assertion masks the stale data. |
| M2 | MEDIUM | Stale `'test'` references in agent-facing docs (`platform-docs-data.ts`, `build-docs-index.ts`) — agents reading this may attempt to send `'test'` which is now rejected. Deferred to WP4/WP5. |
| M3 | MEDIUM | Missing test coverage for UPDATE guard injection (trading agent updated without executionDefaults → mode injected). |
| M4 | MEDIUM | `canonicalizeExecutionMode` return type is overly broad (`string \| null \| undefined` vs `AgentExecutionMode \| null \| undefined`). |
| L1 | LOW | Stale comment in `agent-interactivity.ts` referencing `'test'` alias — **FIXED**. |
| L2 | LOW | Unused `_opts` parameter retained in `canonicalizeExecutionMode`/`normalizeExecutionMode` — still used by `bots.ts` callers. |
| L3 | LOW | `bots.ts` passes ignored `hasConnections` opt to `canonicalizeExecutionMode` — harmless but misleading. |

### WP4 — Repair existing agent data

| # | Priority | Description |
|---|----------|-------------|
| M1 | MEDIUM | N+1 query pattern — each affected agent triggers a separate connection check query. Could be batched into a single query. |
| M2 | MEDIUM | No transaction wrapping — partial repair on crash is recoverable via idempotency, but no atomicity guarantee. |
| M3 | MEDIUM | `TRADING_PROVIDERS` hardcoded list duplicates `@herobids/domain` provider catalog — should import `getProviderIdsForRuntimeFamily('trading')`. |
| M4 | MEDIUM | Type cast `as NonNullable<typeof agent.executionDefaults>` bypasses shape checking — could silently break if ExecutionDefaults gains new required fields. |
| L1 | LOW | No `--dry-run` mode for production safety. |
| L2 | LOW | Minor convention: no explicit `process.exit(0)` — diverges from `audit-orphaned-connections.ts`. |
| L3 | LOW | Comment typo: `capability_families` (DB column name) used in JSDoc alongside camelCase code references. |
