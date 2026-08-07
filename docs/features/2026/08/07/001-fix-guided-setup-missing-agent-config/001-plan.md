# Plan: Fix Guided Setup — Chat vs Form Create Parity

**Feature:** Align Guided Setup agent creation with form create
**Date:** 2026-08-07
**Status: In Progress**

## Summary

Agents created via the Guided Setup chat (`chat.ts` `create_agent` tool) bypass `POST /agents` and insert directly into the DB, skipping a broad set of create-time behaviors that the form route performs. One visible outcome is that scanner-gated hybrid agents crash on startup with a `ZodError` (`StrictTechnicalConfigSchema.parse(undefined)`), but the drift is wider than technical config alone: chat-created agents also miss plan-limit enforcement, skill entitlement validation, auto-derived tool grants, persisted runtime defaults, and other normalized fields.

This plan changes the objective from a narrow startup fix to **full chat-vs-form create parity**. The fix should extract the create-time normalization/enrichment logic into shared helpers and have both `POST /agents` and Guided Setup reuse the same path.

## Current Code Truth

1. **`POST /agents` performs broad create-time normalization.** In `apps/api/src/routes/agents.ts`, the form route enforces agent-count limits, resolves `maxBots` from plan limits, auto-populates tool grants from `skillIds`, validates skill selectability/entitlements, resolves authorization mode, resolves strategy presets into `unifiedConfig`, populates `technical.filters`, applies `TechnicalConfigSchema` defaults, stamps adaptive reasoning flags from user AI settings into `runtimePolicyOverrides`, and persists `notificationPolicy`, `wakePreferences`, and other normalized fields.

2. **`chat.ts` `create_agent` bypasses most of that shared behavior.** In `apps/api/src/routes/chat.ts`, the `create_agent` tool case inserts the agent directly with a minimal `unifiedConfig`, empty `toolPolicy`, direct skill revision inserts, and without form-route normalization for plan enforcement, tool grants, skill selectability, technical preset materialization, runtime policy stamping, notification policy, wake preferences, or resolved maxBots.

3. **Guided Setup resolves trading execution differently from form create.** The chat path maps the user-facing `test` choice directly to canonical `shadow`, while form create resolves execution mode via `resolveExecutionModeForSkills()` and enforces `validateConnectionRequirement()`. In the form path, a trading agent with no connection defaults to `paper`, and `shadow` / `live` require at least one connection.

4. **The worker rejects scanner-gated agents without `technical`.** In `apps/worker/src/index.ts:1020`, `onSessionActive` calls `StrictTechnicalConfigSchema.parse(rawTechnical)` — receiving `undefined` for chat-created scanner-gated agents, which throws `ZodError` and stops the agent container.

5. **`manage_bot` is disabled by default unless create-time policy enables it.** The form route auto-enables the brokered `manage_bot` grant when `bot-management` is selected; the chat route currently persists `{}` for `toolPolicy`, while the worker default policy keeps `manage_bot` off.

6. **Strategy-preset resolution is currently private to `agents.ts`.** `resolveAgentStrategyPreset()` is not shared, even though both the form and chat paths need the same preset-to-config materialization.

## Problem Statement

Agents created through the Guided Setup chat are not create-parity with form-created agents. The drift includes:

| Priority | Gap | Impact |
|----------|-----|--------|
| 🔴 Critical | `unifiedConfig.technical` | Scanner-gated hybrid agents crash on startup. Mixed-mode agents have no scanner settings. |
| 🟠 High | Execution-mode normalization and connection requirement enforcement | Guided Setup can create trading agents with `shadow` semantics when form create would default to `paper` or reject missing connections. |
| 🟠 High | `unifiedConfig.technical.filters` (venue/venueType) | Scanner doesn't know which venue to scan. |
| 🟠 High | `unifiedConfig.execution` (positionSizeMode, etc.) | Preset-derived execution defaults lost. |
| 🟠 High | Plan enforcement and resolved `maxBots` | Guided Setup can drift from form behavior on plan limits and stored bot limits. |
| 🟠 High | Tool-policy derivation from selected skills | Guided Setup agents can miss grants such as `manage_bot`, causing capability mismatch at runtime. |
| 🟠 High | Skill entitlement/selectability validation | Guided Setup can assign skills more loosely than the form route. |
| 🟠 High | Persisted runtime defaults (`runtimePolicyOverrides`, adaptive reasoning flags, `wakePreferences`, `notificationPolicy`, resolved authorization mode) | Guided Setup agents can start with different runtime behavior and user-facing policy than form-created agents. |
| 🟡 Medium | `unifiedConfig.metadata` (strategy preset identity) | Lost for audit and UI display. |
| 🟡 Medium | `TechnicalConfigSchema` defaults not applied | Fields like `scanBatchSize`, `autonomousExit` use raw defaults, not schema defaults. |
| 🟡 Low | `skillPresetId` in metadata | Inconsistent with form-created agents. |

## Goal

Make Guided Setup-created agents create-parity with form-created agents by reusing the same normalization, validation, enrichment, and persistence logic wherever the inputs overlap, and by applying the same backend defaults when Guided Setup does not collect a form field.

## Acceptance Bar

Parity means:
- **Exact form execution semantics for trading agents.** A Guided Setup user-facing `test` choice must persist the same canonical mode the form path would persist: `paper` when no trading connection exists, `shadow` when one does.
- **Shared persisted create-time business state for overlapping inputs.** When chat and form collect or can derive the same domain input, they should persist the same normalized business fields.
- **Shared backend defaults for uncollected optional fields.** When Guided Setup does not collect optional form fields yet (for example `notificationPolicy`, `wakePreferences`, `telegramChatId`), the backend should persist the same default or null behavior the form path uses when those fields are omitted.
- **Provenance fields may differ intentionally.** Audit/source markers such as assignment source may remain different where that difference is meaningful and does not affect runtime behavior or domain state.

## Non-Goals

- Do not change the Guided Setup chat prompt or UX flow.
- Do not change worker startup validation (it is correct — agents MUST have valid config).
- Do not change `POST /agents` behavior.
- Do not change create-time semantics in only one path when parity is the stated objective.
- Do not introduce chat-only risk behavior that differs from form create.

## Decisions

1. **Shared create helpers, not route-specific copies.** The parity objective is broader than strategy presets. Extract the reusable create-time helpers from `agents.ts` into shared API modules, and make both form create and Guided Setup call them.

2. **Preserve form-create semantics.** When the form route today does not derive a field on create (for example preset risk overrides into `risk` JSONB), Guided Setup must not invent chat-only behavior. Any semantic changes must be applied through shared logic or deferred to a separate parity-neutral feature.

3. **Parity covers overlapping fields plus omitted-field defaults.** Guided Setup does not expose every form input. For fields the chat flow does collect or can derive server-side, it should persist the same normalized values as form create. For fields it does not collect yet, it should persist the same default/null state the form route uses when those fields are omitted.

4. **Prefer shared persisted normalization over ad hoc behavioral matching.** The architecturally sound solution is one shared create-time normalization contract reused by both routes. Runtime parity should fall out of that shared persisted state, rather than from chat-specific patches.

## Proposed Changes

### 1. Extract shared create-time normalization helpers **[DONE]**

**New modules:** under `apps/api/src/agents/`

At minimum, extract helpers for:
- strategy-preset resolution (`resolveAgentStrategyPreset`)
- trading execution-mode normalization / connection validation
- tool-policy derivation from `skillIds`
- skill assignment validation / latest-revision resolution
- `unifiedConfig` enrichment (metadata, `technical.filters`, `TechnicalConfigSchema` defaults, authorization mode)
- server-derived create defaults (`resolvedMaxBots`, adaptive reasoning flags in `runtimePolicyOverrides`, notification/wake policy normalization where applicable, and the default/null persistence contract for fields Guided Setup does not collect yet)

These helpers should be invoked by both `POST /agents` and Guided Setup create. Avoid route-to-route imports.

**Update:** `apps/api/src/routes/agents.ts`
- Replace inlined create-time logic with calls to the shared helpers.

**Update:** `apps/api/src/routes/chat.ts`
- Replace ad hoc create-time logic with the same shared helpers.

### 2. Bring Guided Setup onto shared execution-mode and connection semantics **[DONE]**

Guided Setup should stop mapping the user-facing `test` choice directly to canonical `shadow` in isolation.

Instead, the chat path should translate the user-facing choice into the same canonical create contract used by form create, then run the shared execution-mode and connection validation helpers so that:
- non-trading agents persist `executionDefaults: null`
- trading agents with no connection can land in `paper` when appropriate
- `shadow` and `live` still require at least one granted connection
- the stored canonical execution mode matches form-create behavior

This shared path should be applied before persistence and before any confirmation summary is returned to the user.

### 3. Bring Guided Setup onto shared strategy-preset materialization **[DONE]**

**Update:** `apps/api/src/routes/chat.ts` — the `create_agent` case (~line 896)

After building the chat payload, call the shared preset resolver used by form create so that Guided Setup gets the same:
- `unifiedConfig.technical`
- `unifiedConfig.execution`
- `unifiedConfig.metadata`
- preset-managed technical defaults

```typescript
const enrichedCreate = await prepareAgentCreateFields({
  source: 'guided_setup',
  input: payload,
  userId,
  ...deps,
});
```

Key rule: chat-determined values such as `capabilityMode`, `hybridMode`, and `platformAssessment` should flow through the same merge/normalization contract as form create, not a parallel merge scheme.

### 4. Reuse form-create skill validation and assignment logic **[DONE]**

Guided Setup should stop doing direct latest-revision inserts without the form route's selectability checks.

Use the same shared path that form create uses for:
- validating that selected skills exist
- checking whether the user may select them
- resolving latest revision IDs
- writing normalized assignments

```typescript
const assignmentResolution = await resolveSkillAssignmentsForUser(...);
await syncAgentSkillAssignments(...);
```

### 5. Reuse form-create tool-policy derivation **[DONE]**

Guided Setup should stop persisting `{}` for `toolPolicy` unconditionally.

Use the same helper that form create uses to derive tool grants from selected skills, including enabling `manage_bot` when `bot-management` is present.

### 6. Reuse form-create plan enforcement and resolved defaults **[DONE]**

Guided Setup should use the same create-time server-side derivations as form create for overlapping fields:
- agent-count / plan-limit enforcement
- resolved `maxBots`
- authorization mode normalization
- adaptive reasoning flags stamped into `runtimePolicyOverrides`
- omitted-field defaults for `notificationPolicy`, `wakePreferences`, and `telegramChatId`
- `notificationPolicy` normalization when relevant
- `wakePreferences` persistence when relevant

This logic should be shared, not copied.

### 7. Keep `risk` create semantics aligned across both paths **[DONE]**

Do **not** add chat-only preset risk overrides.

If create-time risk semantics are meant to change, do it via the shared create helper and apply it to both form and chat. Otherwise, preserve the existing form-create behavior and leave `risk` sourced only from explicit creator input.

### 8. Stamp metadata and filters through shared `unifiedConfig` enrichment **[DONE]**

Ensure Guided Setup gets the same post-resolution enrichment as form create:
- `skillPresetId` in metadata
- `authorizationMode` in `unifiedConfig`
- `technical.filters` from selected connection
- `TechnicalConfigSchema` defaults applied before persistence

This should remain one shared enrichment path, not a special-case patch in chat.

## Files Changed

| File | Change |
|------|--------|
| `apps/api/src/agents/strategy-preset-resolver.ts` | **NEW** — extracted shared preset resolver |
| `apps/api/src/agents/agent-create-normalization.ts` | **NEW** — shared create-time normalization/enrichment helpers |
| `apps/api/src/routes/agents.ts` | Replace inlined create logic with shared helpers |
| `apps/api/src/routes/chat.ts` | Replace ad hoc Guided Setup insert prep with shared helpers |

## Testing

- **Unit test:** Add tests for the extracted `resolveAgentStrategyPreset` (verify it produces the same output as the old inlined version).
- **Unit test:** Add tests for shared create normalization helpers: execution-mode normalization, connection validation, tool-policy derivation, metadata stamping, `technical.filters`, `TechnicalConfigSchema` defaulting, resolved `maxBots`, and runtime-policy stamping.
- **Integration test:** Create equivalent agents through `POST /agents` and Guided Setup, then compare persisted fields that should match: `unifiedConfig`, `toolPolicy`, `maxBots`, `executionDefaults`, skill assignments, and other normalized create-time fields.
- **Integration test:** Create a scanner-gated hybrid agent via the Guided Setup chat, start it, and verify it reaches `running` status without `ZodError`.
- **Integration test:** Create a trading agent through Guided Setup with no connection and user-facing `test`, then verify the stored canonical execution mode matches form-create semantics.
- **Integration test:** Create paired chat/form agents with omitted optional fields and verify the persisted default/null state matches for `notificationPolicy`, `wakePreferences`, and `telegramChatId`.
- **Manual smoke test:** Create trading agents via chat for each filterTrades option (off, mixed, scanner_gated), start them, and verify behavior matches form-created equivalents.
- **Manual smoke test:** Create a Guided Setup agent with `bot-management` and confirm bot-management tools are actually available at runtime.

## Outstanding Issues

### From GAP fix review (2026-08-07)

#### LOW
1. **Comment incompleteness** — GAP-2 fix comment mentions `capabilityMode` change but is silent about removal of `hybridMode = 'mixed'`.
2. **`deriveCapabilityMode` unreachable for trading presets in else-branch** — By design, but if `deriveCapabilityMode` is refactored, this branch would need updating.

---

### From code review of Item 4 implementation (2026-08-07)

#### MEDIUM
1. **Route-to-route import** — `chat.ts` imports `resolveSkillAssignmentsForUser` and `syncAgentSkillAssignments` from `./agents.js`. The plan says "Avoid route-to-route imports." Should extract both functions into `apps/api/src/agents/skill-assignment.ts`.
2. **Duplicated plan-policy resolution** — Chat route inlines `resolvePlanSkillEntitlements(...)` while form route wraps in `resolveSkillPlanPolicy` helper. If fallback changes, chat could drift.
3. **`assignmentSource` type narrower than DB column** — Function signature uses `'user_select' | 'guided_setup'` but DB column is freeform `text`.

#### LOW
4. **`skillUsageEvents.metadata.source` hardcoded** — Always records `'agent_update'` regardless of `assignmentSource`. Audit trail doesn't distinguish chat vs form assignments.
5. **`new Set()` lacks explanatory comment** — The empty set for `preservedSkillIds` in chat's create path could use a comment.

### From code review of Item 1 implementation (2026-08-07)

#### MEDIUM
1. **`agentRiskDefaults` accepted but unused in `prepareAgentCreateFields`** — The `PrepareAgentCreateFieldsParams` interface declares `agentRiskDefaults`, and chat route passes it, but the function body never reads it. Either remove or implement operator-default risk stamping.
2. **`prepareAgentCreateFields` silently clamps `maxBots` exceeding plan limits** — The code silently clamps `requestedMaxBots` to `planLimits.maxBots` instead of erroring. The "trust the caller" comment contradicts the silent clamp behavior.

#### LOW
3. **Form route bypasses shared helper's `maxBots`/plan logic** — Form route doesn't pass `plansConfig`/`userPlanId`/`isAdmin` to `prepareAgentCreateFields`, making the plan-enforcement branch in the shared helper dead code for the form path. Two different code paths exist depending on which route calls it.
4. **Form route doesn't use `createFields.strategy` from shared helper** — Form route recomputes `strategyJsonb` independently instead of using `createFields.strategy`. Latent maintenance hazard if the shared helper ever enriches strategy.

---

## Rollback

If the shared-helper extraction causes issues, both routes can temporarily revert to their previous inlined logic. Because the goal is parity, avoid rolling back only one route unless the temporary divergence is explicitly accepted.

## Dependencies

- Depends on: `@herobids/domain` exports `applyPresetToAgent`, `agentStyleToPresetStyle` (already exported)
- Depends on: `@herobids/domain/config/presets-loader` exports `getPreset` (already exported)
- Depends on: `TechnicalConfigSchema` from `@herobids/domain` (already exported)
- Depends on: `venueTypeFromProvider` from `@herobids/domain` (already exported)
- Depends on: existing form-route helpers that should be extracted rather than duplicated (`resolveSkillAssignmentsForUser`, tool-policy derivation, create-time normalization logic)
