# Plan: Per-Agent Runtime Controls

**Status:** draft  
**Created:** 2026-06-27  
**Feature ID:** 007-per-agent-runtime-controls

## Problem

Agent runtime behavior is controlled by a mix of operator-level config (`config/default.yaml` → `agentRuntime`), per-agent DB columns (risk limits, cost presets), and hardcoded constants in `apps/worker/src/agent.ts`. This creates tension:

- A "bold" agent that wants deep tool loops and generous context can't get them — `scout.maxTurns: 10` and `maxHistoryTokens: 40000` are operator-global.
- A "careful" cost-conscious agent can't dial them back below the operator default.
- A security-auditor agent that needs 200+ tool turns has no mechanism to request them.
- Adding a new control requires a DB migration, API schema change, worker wiring, and UI — every time.

The user wants agents to have different resource profiles — and is willing to let users pay for deeper profiles.

## Scope

Make the following categories per-agent configurable, with user-facing style presets (Careful / Balanced / Bold) and per-field overrides:

| Category | New Fields (per-agent) |
|---|---|
| **1. Tool Turn Limits** | `scoutMaxTurns`, `judgeMaxTurns` |
| **2. LLM Token Limits** | `scoutMaxTokens`, `judgeMaxTokens`, `lightThinkingTokens`, `deepThinkingTokens` |
| **4. Trading Hours** | `allowedHoursUtc`, `weekendPause` |
| **11. Context Budgets** | `maxHistoryMessages`, `maxHistoryTokens`, `maxRecentToolMessages`, `maxToolResultChars`, `maxVisibleToolSchemas`, `maxContextBlockChars`, `toolResultFullRetentionTurns`, `toolResultMaxStaleChars` |
| **14. Scout Hold** | `maxHoldDurationMs` |

Also:
- **Remove** `agentRiskDefaults.minPaperCyclesBeforeLive` — dead code, no tool consumes it.
- **Remove** `dailyTokenBudget` / `dailyLlmTokenBudget` from the agents table — superseded by the new unified override model (monthly spend caps are handled by usage billing `hardCapMicrousd`).

**Out of scope:**
- Categories 7 (Sandbox), 8 (Capability Policy), 9 (Tool-Specific Args) — these will vary by *subscription plan* in a separate feature.
- Category 3 (Spend & Billing) — already per-agent.
- Category 5 (Risk/Trading Limits) — already per-agent with existing DB columns.
- Category 13 (Live Rollout) — operator-level infrastructure.
- Category 15 (LLM Retry) — operator-level infrastructure.
- `LLM_TIMEOUT_MS` — remains operator-level (provider latency is an infrastructure concern, not agent behavior).

## Design Decisions

### Storage: `style` column + `runtime_policy_overrides` JSONB

The `style` column (`careful` | `balanced` | `bold`) already exists on the `agents` table. We add a single `runtime_policy_overrides` JSONB column. Resolution at agent container startup:

```
effective = STYLE_CONFIG[style]  ∪  runtime_policy_overrides
```

Rationale:
- No migration needed for new fields — they live in JSONB.
- The `style` column is queryable (`WHERE style = 'bold'`).
- Platform-wide default tuning doesn't need per-row updates.
- No backward compatibility constraint — clean break allowed.

### Agent Immutability

All new fields are **user-configured, immutable to agents** — same model as `dailyLossLimit`. The agent cannot increase its own `maxTurns` or context budgets. If it needs more, it uses `send_message` to ask the user.

### No Agent Style Affects Cost Preset

An agent's `style` (Careful/Balanced/Bold) controls tool depth and context breadth. It is **orthogonal** to `costPreset` (Minimal/Standard/Premium) which controls model tier and spending budget. A user can create a "Bold + Minimal" agent (deep tool loops on cheap models) or a "Careful + Premium" agent (shallow loops on expensive models).

---

## Style Defaults

| Config | Careful | Balanced | Bold |
|---|---|---|---|
| `costPreset` | minimal | standard | premium |
| `tickIntervalMins` | 90 | 30 | 10 |
| `dailySpendBudgetUsd` | 3 | 10 | 30 |
| `openPositionEscalationToJudgePolicy` | never | uncovered_or_triggered | always |
| **Tool Turns** | | | |
| `scoutMaxTurns` | 10 | 30 | 100 |
| `judgeMaxTurns` | 25 | 75 | 300 |
| **Token Limits** | | | |
| `scoutMaxTokens` | 512 | 1,024 | 2,048 |
| `judgeMaxTokens` | 2,048 | 4,096 | 8,192 |
| `lightThinkingTokens` | 1,024 | 2,048 | 4,096 |
| `deepThinkingTokens` | 4,096 | 10,240 | 20,480 |
| **Trading Hours** | | | |
| `allowedHoursUtc` | [14–20] (US overlap) | [] (always) | [] (always) |
| `weekendPause` | true | true | false |
| **Context Budgets** | | | |
| `maxHistoryMessages` | 10 | 20 | 40 |
| `maxHistoryTokens` | 20,000 | 40,000 | 80,000 |
| `maxRecentToolMessages` | 3 | 6 | 12 |
| `maxToolResultChars` | 2,000 | 4,000 | 8,000 |
| `maxVisibleToolSchemas` | 32 | 64 | 128 |
| `maxContextBlockChars` | 2,000 | 4,000 | 8,000 |
| `toolResultFullRetentionTurns` | 2 | 3 | 5 |
| `toolResultMaxStaleChars` | 250 | 500 | 1,000 |
| **Scout Hold** | | | |
| `maxHoldDurationMs` | 10,800,000 (180 min) | 3,600,000 (60 min) | 1,800,000 (30 min) |

---

## Implementation Plan

### Phase 1: Domain Schemas & Types

**Goal:** Define the canonical shapes for style defaults and per-agent overrides. Remove dead code.

**Files:**

| File | Change |
|---|---|
| `packages/domain/src/config/schema.ts` | Remove `minPaperCyclesBeforeLive` from `AgentRiskDefaultsSchema`. Add `AgentRuntimePolicyOverridesSchema` (all fields optional + nullable). Add `AgentStyleRuntimeDefaultsSchema` (full STYLE_CONFIG shape). Export new types. |
| `packages/domain/src/config/schema.test.ts` | Test style defaults resolve correctly. Test overrides merge. Test validation rejects out-of-range values. |
| `packages/domain/src/tools.ts` | Remove `getMinPaperCyclesBeforeLive()` from `ToolContext.agentConfigOps` interface. |
| `packages/domain/src/runtime-composition.ts` | Extend `RuntimeBudgetPolicy` to carry per-agent override values (so context-diff and tool-loop truncation logic can read them). |

**Validation rules:**
- Every numeric field has `min` / `max` bounds matching the operator ceiling.
- `allowedHoursUtc` elements must be 0–23.
- `style` must be `'careful' | 'balanced' | 'bold'`.
- Operator ceiling constants defined in one place, referenced by both the Zod schema and the YAML config.

**Tests:**
- `parse({})` → all fields undefined (no overrides requested).
- `parse({ scoutMaxTurns: 50 })` → only `scoutMaxTurns` populated.
- `parse({ scoutMaxTurns: 0 })` → Zod error (min 1).
- Style defaults resolve: `'bold'` → `scoutMaxTurns: 100`, `'careful'` → `scoutMaxTurns: 10`.
- Merge: style defaults + overrides → overrides win on a per-field basis.

---

### Phase 2: Database

**Goal:** Add `runtime_policy_overrides` JSONB column. Remove `daily_token_budget` and `daily_llm_token_budget`. Generate migration.

**Files:**

| File | Change |
|---|---|
| `packages/db/src/schema/agents.ts` | Add `runtimePolicyOverrides: jsonb('runtime_policy_overrides').$type<AgentRuntimePolicyOverrides>()`. Drop `dailyTokenBudget`, rename if still present. Drop any references to `dailyLlmTokenBudget`. |
| `packages/db/drizzle/` | Auto-generated migration via `drizzle-kit generate`. |

**Tests:**
- Migration runs cleanly (`pnpm --filter @herobids/db run migrate`).
- Insert agent with overrides, read back, verify JSONB round-trips.

---

### Phase 3: API Routes

**Goal:** Accept `style` + `runtimePolicyOverrides` on create/update. Validate against operator ceilings. Resolve effective policy for API responses.

**Files:**

| File | Change |
|---|---|
| `apps/api/src/routes/agents.ts` | `CreateAgentSchema`: add `runtimePolicyOverrides`. `UpdateAgentSchema`: add `runtimePolicyOverrides` (nullable, undef = leave unchanged). New helper: `validateRuntimePolicyOverrides()` — checks each field against operator ceilings. Remove `dailyTokenBudget` / `dailyLlmTokenBudget` from schemas. |
| `apps/api/src/routes/agent-interactivity.ts` | Same — update the `UpdateAgentSchema` used by the PUT route. |
| `apps/api/src/routes/agent-config-helpers.ts` | `decorateAgentResponse()`: resolve effective runtime policy (style defaults + overrides) and include in the agent response shape. |
| `apps/api/src/routes/agents.ts` → `POST /agents` | Insert `runtimePolicyOverrides` into the agents table. Remove `dailyTokenBudget` insert. |
| `apps/api/src/routes/agent-interactivity.ts` → `PUT /agents/:id` | Merge `runtimePolicyOverrides` on update (null = clear, undefined = leave unchanged, object = replace). |
| `apps/api/src/routes/agents.ts` → `GET /agents/risk-defaults` | Remove `minPaperCyclesBeforeLive` from response. Add operator ceiling constants for the new fields. |

**New helper — `validateRuntimePolicyOverrides()`:**
```typescript
function validateRuntimePolicyOverrides(
  overrides: AgentRuntimePolicyOverrides | undefined,
  ceilings: RuntimePolicyCeilings
): ZodIssue[] {
  // For each field present in overrides, check ≤ ceiling.
  // Return custom issues for any violation.
}
```

**Tests:**
- Create agent with `style: 'bold'` → agent stored with style, no overrides.
- Create agent with `style: 'balanced'` + `{ scoutMaxTurns: 50 }` → stored.
- Create agent with `{ scoutMaxTurns: 99999 }` → rejected (exceeds operator ceiling).
- Update agent: change style → effective defaults change.
- Update agent: set override → effective value changes.
- Update agent: null out override → field reverts to style default.
- GET agent → response includes resolved `runtimePolicy` with effective values.

---

### Phase 4: Worker — Session Manager

**Goal:** Read `style` + `runtimePolicyOverrides` from the agent DB row, resolve effective policy, inject into the container environment.

**Files:**

| File | Change |
|---|---|
| `apps/worker/src/agents/agent-session-manager.ts` | After reading the agent row, resolve effective runtime policy. Merge into `AGENT_CONFIG` JSON. Add new env var `AGENT_RUNTIME_POLICY_OVERRIDES` to carry the resolved effective values so the container doesn't need DB access. |
| `apps/worker/src/agents/docker-agent-manager.ts` | Pass `AGENT_RUNTIME_POLICY_OVERRIDES` as a container env var. |
| `apps/worker/src/agents/agent-runtime-launcher.ts` | Same for local (non-Docker) dev mode. |

**Resolution logic (new shared helper):**
```typescript
function resolveEffectiveRuntimePolicy(
  style: AgentStyleValue,
  overrides: AgentRuntimePolicyOverrides | null
): ResolvedAgentRuntimePolicy {
  const defaults = STYLE_CONFIG[style] ?? STYLE_CONFIG.balanced;
  return { ...defaults, ...overrides }; // shallow merge, overrides win
}
```

**Tests:**
- Style 'bold' with no overrides → all bold defaults in env var.
- Style 'balanced' with `{ scoutMaxTurns: 50 }` → all balanced defaults except scoutMaxTurns=50.
- Missing/invalid style → falls back to balanced.

---

### Phase 5: Worker — Agent Container

**Goal:** The agent container reads the resolved policy and wires it into the runtime loop, replacing hardcoded operator defaults.

**Files:**

| File | Change |
|---|---|
| `apps/worker/src/agent.ts` | **`AgentConfig` interface**: add `resolvedRuntimePolicy?: ResolvedAgentRuntimePolicy`. **Parse**: read `AGENT_RUNTIME_POLICY_OVERRIDES` env var, JSON.parse. **Wire**: Replace `scoutLoopConfig.maxTurns` / `judgeLoopConfig.maxTurns` with resolved values. Replace `scoutMaxTokens` / `judgeMaxTokens` in LLM call configs. Replace thinking budget tokens. Replace `maxHoldDurationMs`. Replace `runtimeState.runtimeDescriptor.budgets.*` with resolved context budget values. Replace trading hours config. **Remove**: `getMinPaperCyclesBeforeLive()` implementation and `minPaperCyclesBeforeLive` from `AgentConfig`. |
| `apps/worker/src/cost-profile.ts` | No changes needed — cost presets remain orthogonal to agent style. |
| `apps/worker/src/tick-gates.ts` | `TradingHoursConfig` passed through from resolved policy (already supported, just changing the source). |

**Wiring detail — context budgets:**
```typescript
// BEFORE: operator defaults from agentRuntimePolicy
const budgets = agentRuntimePolicy.defaultBudgets;

// AFTER: resolved per-agent values
const resolved = runtimeState.resolvedRuntimePolicy;
const budgets: RuntimeBudgetPolicy = {
  maxHistoryMessages: resolved.maxHistoryMessages,
  maxHistoryTokens: resolved.maxHistoryTokens,
  maxRecentToolMessages: resolved.maxRecentToolMessages,
  maxToolResultChars: resolved.maxToolResultChars,
  maxVisibleToolSchemas: resolved.maxVisibleToolSchemas,
  maxContextBlockChars: resolved.maxContextBlockChars,
  toolResultFullRetentionTurns: resolved.toolResultFullRetentionTurns,
  toolResultMaxStaleChars: resolved.toolResultMaxStaleChars,
};
```

**Wiring detail — trading hours:**
```typescript
// BEFORE: operator-level from llm.tradingHours
const tradingHours = agentRuntimePolicy.llm.tradingHours;

// AFTER: per-agent from resolved policy
const tradingHours: TradingHoursConfig = {
  allowedHoursUtc: resolved.allowedHoursUtc ?? [],
  weekendPause: resolved.weekendPause ?? false,
};
```

**Tests:**
- Agent container starts with `AGENT_RUNTIME_POLICY_OVERRIDES` → values flow into loop configs.
- Scout uses resolved `maxTurns` not operator default.
- Judge uses resolved `maxTurns` not operator default.
- Context budgets in `runtimeState.runtimeDescriptor.budgets` match resolved values.
- Trading hours from resolved policy applied.
- `maxHoldDurationMs` from resolved policy applied.
- Missing env var → falls back to operator `agentRuntime` defaults (backward compat).

---

### Phase 6: Frontend

**Goal:** Add style picker and optional advanced overrides section to the agent create/edit form.

**Files:**

| File | Change |
|---|---|
| `apps/web/src/features/agents/style-mapping.ts` | Expand `STYLE_CONFIG` with all new fields. Export `AgentStyleValue`, `StyleDefaults`, and new `RuntimePolicyDefaults` type. |
| `apps/web/src/features/agents/style-mapping.test.ts` | Add tests for new defaults. |
| `apps/web/src/features/agents/agent-payloads.ts` | Add `runtimePolicyOverrides` to `CreateAgentIntentPayloadInput` and `UpdateAgentPayloadInput`. Add to `buildCreateAgentPayload()` and `buildUpdateAgentPayload()`. |
| `apps/web/src/features/agents/agent-payloads.test.ts` | Test that payloads include overrides when provided. |
| `apps/web/src/features/agents/AgentsPage.tsx` | Add style selector (dropdown: Careful / Balanced / Bold) if not already present. Add collapsible "Advanced" section for per-field overrides. Show derived summary beside style picker (e.g., "100 scout turns, 300 judge turns, ~$30/day estimated"). |
| `apps/web/src/app/i18n/locales/en.ts` | Add i18n strings for: style selector label + help text, each style description, advanced section heading, per-field labels + help text, derived summary text. |
| `apps/web/src/app/i18n/locales/ar.ts` | Same strings in Arabic. |
| `apps/web/src/app/i18n/locales/hi.ts` | Same strings in Hindi. |
| Other i18n locale files | Same strings (es, fr, pt, zh, etc. — whichever active locales exist). |

**UI behavior:**
- Style picker: 3 radio cards or a segmented control.
- Changing style updates the derived summary immediately.
- "Advanced" section collapsed by default. Expanding it shows all per-field inputs pre-populated with the style's defaults. Changing a value marks it as an override (visual indicator).
- Clearing an override reverts to the style default.
- Save sends `style` + sparse `runtimePolicyOverrides` (only overridden fields).

**Tests:**
- Style mapping resolves correct defaults for each style.
- Payload builder includes overrides.
- UI renders style picker and advanced section.

---

### Phase 7: Config & Cleanup

**Goal:** Remove dead config entries. Update YAML comments.

**Files:**

| File | Change |
|---|---|
| `config/default.yaml` | Remove `minPaperCyclesBeforeLive: 10` from `agentRiskDefaults`. Add comment block explaining the new per-agent model. |
| `config/development.yaml` | Remove `minPaperCyclesBeforeLive` if present. |
| `config/staging.yaml` | Remove `minPaperCyclesBeforeLive` if present. |
| `config/production.yaml` | Remove `minPaperCyclesBeforeLive` if present. |
| `config/personal-assistant.yaml` | Remove `minPaperCyclesBeforeLive` if present. |

---

### Phase 8: End-to-End Validation

**Goal:** Full-stack integration test: create agent with style → verify runtime uses correct limits.

**Test scenarios:**

1. **Create Bold agent, start it** → verify container receives `scoutMaxTurns: 100`, `judgeMaxTurns: 300`, context budgets at 2×.
2. **Create Careful agent, start it** → verify container receives `scoutMaxTurns: 10`, `judgeMaxTurns: 25`, weekend pause enabled.
3. **Create Balanced agent with override** → `{ scoutMaxTurns: 50 }` → verify effective is 50 (override wins).
4. **Update agent style from Balanced to Bold** → stop agent, update, start → verify new limits.
5. **Update agent overrides** → `{ maxHoldDurationMs: 900000 }` → verify effective is 900000.
6. **Clear override** → `{ maxHoldDurationMs: null }` → verify reverts to style default.
7. **Missing style** → verify fallback to Balanced.
8. **Exceeds operator ceiling** → API rejects with validation error.
9. **Existing agents without style** → verify fallback to Balanced (default column value).
10. **Agent cannot self-edit** → `adjust_risk_limits` tool does not expose these fields. `get_risk_limits` reports effective values but marks them as `mutable: false`.

---

## Execution Order & Dependencies

```
Phase 1 (Domain) ─────────────────────────────┐
    ↓                                          │
Phase 2 (DB) ──────────────────────────────────┤
    ↓                                          │
Phase 3 (API) ─────────────────────────────────┤
    ↓                                          │
Phase 4 (Worker: Session Manager) ─────────────┤
    ↓                                          │
Phase 5 (Worker: Agent Container) ──┐          │
    ↓                               │          │
Phase 6 (Frontend) ─────────────────┤          │
    ↓                               │          │
Phase 7 (Config Cleanup) ───────────┤          │
    ↓                               │          │
Phase 8 (E2E Validation) ◄──────────┴──────────┘
```

Phases 1–5 are strictly sequential (each depends on the previous). Phases 6 and 7 can run in parallel with Phase 5 once the API schema is stable. Phase 8 is the final gate.

---

## Rollback Plan

- The `style` column already exists with `DEFAULT 'balanced'` — existing agents without explicit style get Balanced defaults, which match current operator defaults.
- `runtime_policy_overrides` defaults to `NULL` — no agent has overrides unless explicitly set.
- `minPaperCyclesBeforeLive` removal: dead code, no runtime impact.
- `dailyTokenBudget` removal: superseded by usage billing hard/soft caps. No agent relies on it for enforcement (the token budget check was never wired into the agent container).
- If rollback needed: deploy previous worker image, revert API schema changes. No data loss risk — the new column is additive.

---

## Risks & Open Questions

1. **Operator ceiling defaults** — What is the absolute platform max for `scoutMaxTurns`? Proposed: 500. For `judgeMaxTurns`? Proposed: 1000. These need operator sign-off. - **Agreed and proposal accepted**.
2. **Context budget ceiling** — `maxHistoryTokens: 80000` for Bold. Is this safe for all supported models' context windows? Need to verify against model context limits (Claude 200K, GPT-4 128K, etc.).
3. **Style picker UX** — The existing agent create form is already complex. Adding an "Advanced" section could overwhelm users. Consider progressive disclosure: style picker is prominent, advanced overrides behind a "Customize limits" link.
