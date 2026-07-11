# Adaptive Reasoning Toggle

Give users a per-agent switch to control whether `scoutReasoning` and `judgeReasoning` act as **ceilings** (adaptive — the system can escalate thinking for critical events) or as **fixed levels** (direct-mapped — same reasoning every tick). Default: adaptive (current behaviour). When adaptive is off, the configured reasoning level is used exactly as-is, with **no `classifyTickThinking` and no `applyReasoningCeiling`** — giving a clean, deterministic 4×4 test matrix with zero runtime variance.

---

## Background

Currently:
- **Scout** uses `scoutReasoning` directly (no ceiling logic).
- **Judge** uses `judgeReasoning` as a ceiling via `applyReasoningCeiling()` — the system can escalate to `deep` thinking on regime flips, drawdowns, user messages, etc. The user level caps the maximum.

This is safe by default but **prevents deterministic testing**. A user setting `judgeReasoning: 'medium'` can't predict what actually runs because every tick might get a different level depending on runtime conditions. The ceiling also makes it hard to calibrate cost vs. performance.

The solution: a boolean toggle (`adaptScoutReasoning` / `adaptJudgeReasoning`) that, when `false`, **skips `classifyTickThinking` and `applyReasoningCeiling` entirely** — the reasoning level is used directly. Default `true` preserves current behaviour.

The toggle is **in user Settings (visible to all users)**, flowing through to agent `runtimePolicyOverrides` at creation/edit time.

---

## Design Decisions

### Scout gets adaptive too

Previously scout had NO ceiling — it was always direct-mapped. Adding `adaptScoutReasoning` (default `true`) makes scout consistent with judge: by default the system can escalate scout thinking for critical conditions (regime flip, drawdown, user message). When toggled off, scout reasoning is fixed at the configured level.

### Settings page, not agent form (for now)

Controls in `/settings` (visible to all users) keep the feature contained while we validate. Later, the agent form can expose per-agent reasoning overrides directly. For now, the user setting flows through to agent `runtimePolicyOverrides` at creation/edit time.

### Stored in `users.aiModelConfig` JSONB, stamped into agent `runtimePolicyOverrides`

The user's adaptive reasoning preferences are stored in the existing `users.aiModelConfig` JSONB column — same pattern as provider/model prefs, no migration needed. At agent creation/edit time, the user's prefs are stamped into `AgentRuntimePolicyOverrides` so they participate in the existing resolution pipeline (style defaults → user overrides → operator ceilings). This means:
- User preferences set via the Settings API → `users.aiModelConfig`
- Agent creation/edit stamps them into `runtimePolicyOverrides`
- At runtime, the worker reads them from `resolvedRuntimePolicy`

### `medium` vs `high` still identical for judge ceiling

When adaptive is ON for the judge, `medium` and `high` both cap at `deep` (the max `TickThinkingLevel`). This is unchanged. The distinction between `medium` and `high` matters in two cases:
1. **Scout path** — different token budgets in `resolveReasoningParams()`
2. **Judge path with adaptive OFF** — direct-mapped, different token budgets

---

## Step 1 — Domain: add `adaptScoutReasoning` and `adaptJudgeReasoning`

**Files:**
- `packages/domain/src/config/schema.ts`

### Changes

1. **Add fields to `ResolvedAgentRuntimePolicy` interface:**
   ```typescript
   adaptScoutReasoning: boolean;
   adaptJudgeReasoning: boolean;
   ```

2. **Add both fields to `AGENT_STYLE_RUNTIME_DEFAULTS`** for all three styles:
   ```typescript
   adaptScoutReasoning: true,
   adaptJudgeReasoning: true,
   ```

3. **Add both fields to `AgentRuntimePolicyOverridesSchema`:**
   ```typescript
   adaptScoutReasoning: z.boolean().nullable().optional(),
   adaptJudgeReasoning: z.boolean().nullable().optional(),
   ```

4. **Update `resolveAgentRuntimePolicy`** to pass through both fields:
   ```typescript
   adaptScoutReasoning: o.adaptScoutReasoning ?? defaults.adaptScoutReasoning,
   adaptJudgeReasoning: o.adaptJudgeReasoning ?? defaults.adaptJudgeReasoning,
   ```

5. **No new operator ceiling needed** — boolean field doesn't need a ceiling.

### Checklist
- [ ] `ResolvedAgentRuntimePolicy` extended
- [ ] `AGENT_STYLE_RUNTIME_DEFAULTS` includes both fields (all three styles)
- [ ] `AgentRuntimePolicyOverridesSchema` accepts both fields
- [ ] `resolveAgentRuntimePolicy` resolves both fields
- [ ] `pnpm lint` passes (packages/domain)

---

## Step 2 — Frontend: add fields to `style-mapping.ts`

**Files:**
- `apps/web/src/features/agents/style-mapping.ts`

### Changes

1. **Add to `StyleDefaults` interface:**
   ```typescript
   adaptScoutReasoning: boolean;
   adaptJudgeReasoning: boolean;
   ```

2. **Add to `RuntimePolicyOverrides` type:**
   ```typescript
   adaptScoutReasoning: boolean | null;
   adaptJudgeReasoning: boolean | null;
   ```

3. **Add to `STYLE_CONFIG`** for all three styles (`true`):
   ```typescript
   adaptScoutReasoning: true,
   adaptJudgeReasoning: true,
   ```

4. **Update `resolveStyleDefaults`** — no change needed (returns the STYLE_CONFIG entry directly).

### Checklist
- [ ] `StyleDefaults` extended
- [ ] `RuntimePolicyOverrides` extended
- [ ] `STYLE_CONFIG` includes both fields (all three styles)
- [ ] `pnpm lint` passes (apps/web)

---

## Step 3 — Worker: apply ceiling gate

**Files:**
- `apps/worker/src/agent.ts`

### Changes

1. **Run `classifyTickThinking` once at the top** and share the result between scout and judge dispatch. The runtime conditions (open positions, regime state, incoming messages, drawdown) are available at tick start and don't change between dispatches — this avoids redundant computation.

2. **Scout dispatch** (around line 2875) — gate on `adaptScoutReasoning`:
   ```typescript
   const adaptScout = agentConfig.resolvedRuntimePolicy?.adaptScoutReasoning !== false;
   const scoutReasoning = adaptScout
     ? toReasoningLevel(
         applyReasoningCeiling(
           thinkingDecision.thinking,  // from shared classifyTickThinking
           agentConfig.resolvedRuntimePolicy?.scoutReasoning ?? 'none'
         )
       )
     : (agentConfig.resolvedRuntimePolicy?.scoutReasoning ?? 'none');
   // Then pass scoutReasoning to resolveReasoningParams()
   ```

3. **Judge dispatch** (around line 3087) — gate on `adaptJudgeReasoning`:
   ```typescript
   const userJudgeLevel = agentConfig.resolvedRuntimePolicy?.judgeReasoning ?? 'medium';
   const adaptJudge = agentConfig.resolvedRuntimePolicy?.adaptJudgeReasoning !== false;
   const cappedThinking = adaptJudge
     ? applyReasoningCeiling(systemThinking, userJudgeLevel)
     : (userJudgeLevel === 'none' ? 'none' : userJudgeLevel === 'low' ? 'light' : 'deep');
   ```
   When adaptive is off, `judgeReasoning` maps directly to `TickThinkingLevel`:
   - `'none'` → `'none'`
   - `'low'` → `'light'`
   - `'medium'` → `'deep'`
   - `'high'` → `'deep'`

4. **Logging** — add `adapted: adaptJudge` and `userLevel: userJudgeLevel` to the judge's `logger.info` call so the effective reasoning is always transparent.

### Checklist
- [ ] `classifyTickThinking` called once, result shared
- [ ] Scout dispatch gated on `adaptScoutReasoning` — adaptive: ceiling applied; non-adaptive: direct `scoutReasoning`
- [ ] Judge dispatch gated on `adaptJudgeReasoning` — adaptive: ceiling applied; non-adaptive: direct `judgeReasoning`
- [ ] Logging includes `adapted` flag and `userLevel`
- [ ] `pnpm lint` passes (apps/worker)

---

## Step 4 — UI: checkboxes in Settings page (all users)

**Files:**
- `apps/web/src/features/settings/` (or wherever `/settings` page lives)
- `apps/web/src/app/i18n/locales/en.ts`

### Changes

1. **Add two checkboxes** to the Settings page AI section, **visible to all users**:
   - "Adaptive scout reasoning" — checked by default
   - "Adaptive judge reasoning" — checked by default
   - Helper text: "When enabled, the system may use deeper reasoning for critical events like regime flips and drawdowns. When disabled, the configured level is used exactly as set."

2. **i18n keys** (English only for now):
   ```typescript
   'settings.adaptiveScoutReasoning': 'Adaptive scout reasoning',
   'settings.adaptiveScoutReasoningHelp': 'Allow the system to escalate scout reasoning during critical events.',
   'settings.adaptiveJudgeReasoning': 'Adaptive judge reasoning',
   'settings.adaptiveJudgeReasoningHelp': 'Allow the system to escalate judge reasoning during critical events.',
   ```

3. **No admin gate** — controls are visible to all users in the Settings page.

### Checklist
- [ ] Checkboxes render in Settings page for all users
- [ ] Checked by default (matching style defaults)
- [ ] i18n keys added (English)
- [ ] Helper text explains the ceiling behaviour
- [ ] `pnpm lint` passes (apps/web)

---

## Step 5 — API: store user settings and stamp agents

**Files:**
- `apps/api/src/routes/settings.ts` (reuse existing `PATCH /settings/ai-model` endpoint)
- `apps/api/src/routes/agents.ts`

### Changes

1. **Extend `PATCH /settings/ai-model`** to accept the two new fields alongside the existing provider/model fields:
   ```json
   {
     "provider": "openai",
     "lightModel": "gpt-4o-mini",
     "heavyModel": "gpt-4o",
     "adaptScoutReasoning": true,
     "adaptJudgeReasoning": true
   }
   ```
   Stored in `users.aiModelConfig` JSONB alongside existing model preferences — no new column, no migration. Available to all users (no admin gate).

2. **Agent creation** — `POST /agents` handler reads the user's `aiModelConfig` and stamps the adaptive flags into `runtimePolicyOverrides`:
   ```typescript
   const userConfig = await getAdaptiveReasoningPrefs(db, request.userId);
   if (userConfig) {
     parsed.data.runtimePolicyOverrides = {
       ...parsed.data.runtimePolicyOverrides,
       adaptScoutReasoning: userConfig.adaptScoutReasoning ?? true,
       adaptJudgeReasoning: userConfig.adaptJudgeReasoning ?? true,
     };
   }
   ```

3. **Agent update** — `PUT /agents/:id` does the same stamping.

### Checklist
- [ ] `PATCH /settings/ai-model` extended with `adaptScoutReasoning` / `adaptJudgeReasoning`
- [ ] Preferences persisted in `users.aiModelConfig` JSONB
- [ ] Agent creation stamps adaptive flags into `runtimePolicyOverrides`
- [ ] Agent update stamps adaptive flags into `runtimePolicyOverrides`
- [ ] `pnpm lint` passes (apps/api)

---

## Step 6 — Tests

**Files:**
- `packages/domain/src/config/schema.test.ts`
- `packages/domain/src/config/runtime-policy-propagation.integration.test.ts`
- `apps/web/src/features/agents/style-mapping.test.ts`
- `apps/worker/src/tick-thinking.test.ts`
- `apps/worker/src/tick-gates.test.ts` (if relevant)

### Test cases

1. **Schema** — `AGENT_STYLE_RUNTIME_DEFAULTS` has both fields `true` for all styles
2. **Schema** — `AgentRuntimePolicyOverridesSchema` accepts boolean and null
3. **Resolution** — `resolveAgentRuntimePolicy('balanced', null)` returns both `true`
4. **Resolution** — overrides can set to `false`
5. **Style mapping** — all three styles have `adaptScoutReasoning: true`, `adaptJudgeReasoning: true`
6. **Ceiling logic** — when adaptive is off, `applyReasoningCeiling` is NOT called; direct level used
7. **Ceiling logic** — when adaptive is on, existing behaviour preserved

### Checklist
- [ ] Unit tests pass for domain schema changes
- [ ] Unit tests pass for style mapping changes
- [ ] Integration tests pass for runtime policy resolution
- [ ] Worker tests pass for adaptive/non-adaptive paths

---

## Step 7 — Documentation

**Files:**
- `docs/tech/agents/runtime-policy-and-reasoning.md`
- `docs/tech/user-acceptance-tests.md`

### runtime-policy-and-reasoning.md updates
- [ ] Add `adaptScoutReasoning` / `adaptJudgeReasoning` fields to the style defaults table
- [ ] Add section on adaptive reasoning toggle — explains ceiling vs direct mapping
- [ ] Update the judge path diagram to show the gate
- [ ] Add scout adaptive path documentation
- [ ] Document the Settings page admin control

### user-acceptance-tests.md updates
- [ ] Add test cases under Settings section for adaptive reasoning checkboxes (visible to all users)
- [ ] Add test case for agent creation inheriting adaptive prefs from user settings
- [ ] Add test case for non-adaptive agent having deterministic reasoning (same level every tick)

---

## Source Files Summary

| Layer | File(s) |
|-------|---------|
| Domain types | `packages/domain/src/config/schema.ts` |
| Frontend style defaults | `apps/web/src/features/agents/style-mapping.ts` |
| Worker agent runtime | `apps/worker/src/agent.ts` |
| Worker tick thinking | `apps/worker/src/tick-thinking.ts` |
| Settings UI | `apps/web/src/features/settings/` |
| Settings API | `apps/api/src/routes/settings.ts` (new) |
| Agent API | `apps/api/src/routes/agents.ts` |
| i18n | `apps/web/src/app/i18n/locales/en.ts` |
| Tech docs | `docs/tech/agents/runtime-policy-and-reasoning.md` |
| UAT docs | `docs/tech/user-acceptance-tests.md` |
