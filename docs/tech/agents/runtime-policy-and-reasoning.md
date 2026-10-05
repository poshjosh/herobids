# Runtime Policy & Reasoning Resolution

## Overview

Every agent has a **runtime policy** that controls its trading behaviour: how often it ticks, how much it can spend, when it's allowed to trade, and how deeply it reasons with the LLM. The policy is the composition of three layers:

1. **Style defaults** — per-style baseline (careful / balanced / bold)
2. **User overrides** — per-agent field-level overrides (`runtimePolicyOverrides`)
3. **Operator ceilings** — platform-wide maximums that neither style nor overrides can exceed

```
Style Defaults
    │
    ├── merged with ── User Overrides
    │                        │
    └── capped at ── Operator Ceilings
                            │
                            ▼
                  Resolved Runtime Policy
```

---

## Agent Styles

Three styles define the baseline. All numeric values are backed by
`AGENT_STYLE_RUNTIME_DEFAULTS` in `packages/domain/src/config/schema.ts`
(backend) and `STYLE_CONFIG` in `apps/web/src/features/agents/style-mapping.ts`
(frontend). They must be kept in sync.

| Field | careful | balanced | bold |
|-------|:-------:|:--------:|:----:|
| **Cost preset** | minimal | standard | premium |
| **Tick interval** | 90 min | 30 min | 10 min |
| **Daily spend budget** | $3 | $10 | $30 |
| **Escalation policy** | never | uncovered_or_triggered | always |
| `scoutMaxTurns` | 499 | 499 | 499 |
| `judgeMaxTurns` | 9 999 | 9 999 | 9 999 |
| `scoutMaxTokens` | 512 | 1 024 | 2 048 |
| `judgeMaxTokens` | 2 048 | 4 096 | 8 192 |
| `lightThinkingTokens` | 1 024 | 2 048 | 4 096 |
| `deepThinkingTokens` | 4 096 | 10 240 | 20 480 |
| `scoutReasoning` | none | none | low |
| `judgeReasoning` | low | medium | high |
| `adaptScoutReasoning` | true | true | true |
| `adaptJudgeReasoning` | true | true | true |
| `allowedHoursUtc` | 14–20 | [] (all) | [] (all) |
| `weekendPause` | false | false | false |
| `maxHistoryMessages` | 10 | 20 | 40 |
| `maxHistoryTokens` | 20 000 | 40 000 | 80 000 |
| `maxHoldDurationMs` | 27 000 000 | 5 400 000 | 600 000 |

A missing or invalid style falls back to **balanced**.

### Note on `scoutMaxTurns` / `judgeMaxTurns` and the operator `llm.*` turn config

There is a **second home** for the scout/judge turn caps: the operator config
`agentRuntime.llm.scout.maxTurns` / `agentRuntime.llm.judge.maxTurns`
(`config/default.yaml`, backed by Zod defaults in `schema.ts`). At agent startup
`apps/worker/src/agent.ts` copies the resolved style/override value over the
operator value before the loop reads it, so today the style/instance value wins
and the operator value has no effect for a running agent.

That precedence is **not** what we ultimately want (external operator config
should beat hardcoded defaults, user overrides should beat operator config, all
bounded by the ceiling). Until that is fixed, every tier has been **aligned to
the same near-ceiling values** so whichever one wins produces identical numbers
and nothing is silently contradictory:

- `scoutMaxTurns`: ceiling 500; all styles 499; operator `llm.scout.maxTurns` 499.
- `judgeMaxTurns`: ceiling 10 000; all styles 9 999; operator `llm.judge.maxTurns` 9 999.

**Why near-ceiling and uniform:** turn caps are runaway-loop protection, not
behavioural tuning — the only cost of a high cap is spend, which the daily budget
already governs, so agents are not cut off early. Turn budgets are therefore
intentionally uniform across styles; only token/history/reasoning budgets stay
graduated.

The proper precedence-ladder fix is specified in
[`docs/features/pending/000-runtime-turn-budget-precedence/001-plan.md`](../../features/pending/000-runtime-turn-budget-precedence/001-plan.md).
Do not "fix" the duplication by only editing one home — update the plan or
implement the ladder.

---

## Operator Ceilings

Defined by `RUNTIME_POLICY_CEILINGS` in `packages/domain/src/config/schema.ts`.
No agent can be configured beyond these, regardless of style or overrides.

| Ceiling | Value |
|---------|-------|
| `scoutMaxTurns` | 500 |
| `judgeMaxTurns` | 10 000 |
| `scoutMaxTokens` | 4 096 |
| `judgeMaxTokens` | 16 384 |
| `lightThinkingTokens` | 8 192 |
| `deepThinkingTokens` | 32 768 |
| `scoutReasoningMax` | medium |
| `judgeReasoningMax` | high |
| `maxHistoryMessages` | 80 |
| `maxHistoryTokens` | 160 000 |
| `maxHoldDurationMs` | 86 400 000 (24 h) |

---

## Reasoning Level Resolution

### Background

Reasoning controls how much "thinking budget" the LLM uses before generating a
response. Four levels are defined in `ReasoningLevelSchema`:

| Level | Meaning |
|-------|---------|
| `none` | No reasoning tokens — fastest, cheapest |
| `low` | Light reasoning (e.g. 2 048 tokens) |
| `medium` | Moderate reasoning (~6 144 tokens average) |
| `high` | Deep reasoning (e.g. 10 240+ tokens) |

The actual token budgets come from the **style default** `lightThinkingTokens`
(for `low`) and `deepThinkingTokens` (for `high`). Medium averages the two.

### Scout path (adaptive)

The scout reasoning level can operate in two modes:

- **Adaptive (default)**: The system may escalate scout reasoning for critical
  conditions (regime flips, drawdowns, user messages, runtime events). The
  `scoutReasoning` level acts as a **ceiling** — capping via
  `applyReasoningCeiling()`.
- **Fixed (non-adaptive)**: The configured `scoutReasoning` level is used
  directly as-is — no escalation, no ceiling logic.

The mode is controlled by `adaptScoutReasoning` (default `true`).

```
                    ┌─────────────────────┐
                    │ classifyTickThinking │
                    │   (runtime state)    │
                    │   computed once,     │
                    │ shared with judge    │
                    └──────┬──────────────┘
                           │
                    system thinking level
                    (none / light / deep)
                           │
                    ┌──────▼──────────────┐
                    │ adaptScoutReasoning? │
                    └──┬──────────────┬───┘
                       │ true         │ false
                       ▼              ▼
              applyReasoningCeiling()  direct scoutReasoning
                       │              │
                       ▼              ▼
              toReasoningLevel()     resolveReasoningParams()
                       │
                       ▼
              resolveReasoningParams() → reasoning object for LLM API
```

`resolveReasoningParams()` (in `packages/llm/src/llm-provider.ts`) maps the
level to provider-specific API parameters:

- **Effort-based models** (GPT-4o, Claude): `{ effort: level }`
- **Token-budget models** (older): `{ max_tokens: <budget> }`
- **`none`**: `{ max_tokens: 0 }` (no reasoning), except on
  adaptive-thinking-only models which get `{ effort: 'minimal' }`

### Judge path (dynamic)

The judge path is more complex. Instead of a fixed level, the system first
determines a **desired thinking level** based on the agent's current state, then
**caps** it at the user-configured `judgeReasoning` — but only when
`adaptJudgeReasoning` is `true` (the default).

When `adaptJudgeReasoning` is `false`, the `judgeReasoning` level maps directly
to `TickThinkingLevel`:

| `judgeReasoning` | Direct mapping |
|:----------------:|:--------------:|
| `none` | `none` |
| `low` | `light` |
| `medium` | `deep` |
| `high` | `deep` |

```
                    ┌─────────────────────┐
                    │ classifyTickThinking │
                    │   (runtime state)    │
                    └──────┬──────────────┘
                           │
                    system thinking level
                    (none / light / deep)
                           │
                           ├── cost profile may force deep
                           │
                           ▼
                    applyReasoningCeiling()
                           │
                    capped at user's judgeReasoning
                           │
                           ▼
                    resolveReasoningParams()
                           │
                           ▼
                    LLM API reasoning object
```

#### Step 1: `classifyTickThinking()`

Located in `apps/worker/src/tick-thinking.ts`. Selects the system level based on
runtime conditions (checked in priority order):

| Condition | Selected level | Reason |
|-----------|:--------------:|--------|
| Market regime just flipped | `deep` | `regime_flip` |
| Drawdown ≤ drawdownThresholdPct | `deep` | `drawdown_threshold` |
| User sent a message | `deep` | `user_message` |
| Runtime events incoming | `deep` | `new_runtime_event` |
| Has open positions | `light` | `open_positions` |
| None of the above (routine tick) | `none` | `routine_tick` |

#### Step 2: Cost profile override

If the judge model is premium (`costProfile.defaultThinking === 'deep'`), the
system thinking is forced to `deep` regardless of the tick classifier's decision.

#### Step 3: `applyReasoningCeiling()`

Caps the system level at the user's `judgeReasoning`. The user level is a
**maximum** — the system can reason less, never more.

| System level | user `none` | user `low` | user `medium` | user `high` |
|:------------:|:-----------:|:----------:|:-------------:|:-----------:|
| `none` | none | none | none | none |
| `light` | none | **light** | light | light |
| `deep` | none | **light** | **deep** | **deep** |

#### Step 4: `resolveReasoningParams()`

Same function as the scout path — maps the final `TickThinkingLevel` to the
LLM API reasoning object. `light` maps to `low`, `deep` maps to `high`.

### Key invariant

The `judgeReasoning` field acts as a **ceiling, not a fixed level** when
adaptive reasoning is enabled. An agent
with `judgeReasoning: 'low'` can still think `deep` during a regime flip or
drawdown event — it just can't use deep thinking for routine ticks or open
position management. This ensures critical events always get thorough analysis
while keeping costs low during normal operation.

When adaptive reasoning is **disabled** (`adaptJudgeReasoning: false`), the
configured `judgeReasoning` is used directly — giving a clean, deterministic
4×4 test matrix with zero runtime variance. This is useful for:

- **Cost calibration**: Know exactly what reasoning budget each tick consumes
- **Deterministic testing**: Reproduce the same behaviour every tick
- **Debugging**: Eliminate runtime condition variance from reasoning level

### Settings Page Control

Users can toggle adaptive reasoning for both scout and judge in the
**Settings → AI models** section. The controls are:

- **Adaptive scout reasoning** — Checkbox, checked by default
- **Adaptive judge reasoning** — Checkbox, checked by default

These preferences are stored in `users.aiModelConfig` JSONB and automatically
stamped into an agent's `runtimePolicyOverrides` at creation and update time.
The agent-specific `runtimePolicyOverrides` can override the user-level default.

---

## Trading Hours Gates

The agent's trading schedule is controlled by three fields in the resolved
runtime policy, checked in `apps/worker/src/tick-gates.ts`:

### `allowedHoursUtc: number[]`

List of UTC hours (0–23) the agent is allowed to trade. An empty array means
**all hours allowed**.

Example: `[14, 15, 16, 17, 18, 19, 20]` → trade only 14:00–20:59 UTC.

### `weekendPause: boolean`

When `true`, the agent **skips routine ticks during the weekend**
(Saturday 00:00 UTC through Sunday 12:00 UTC).

**Critical**: weekend pause only applies when the agent has **no open
positions**. If the agent has open positions, ticks continue normally so it can
manage them. The pause only gates new position entry (no-position ticks).

The operator default is `false` (`config/default.yaml`). Style defaults are also
`false` for all three styles since 2026-07-11 (changed from defaulting to
`true` for careful and balanced).

### `tradingSessions: TradingSessionName[] | null`

Named session presets (e.g. `'asia'`, `'london'`, `'ny'`). When set, they
override `allowedHoursUtc`. The presets are defined by
`resolveTradingSessionHours()` in the domain package.

### Gate priority

The tick gate evaluates in order:

1. **Session check**: Are we within the allowed trading window?
   - If `tradingSessions` is set → check session hours
   - Else if `allowedHoursUtc` is non-empty → check current UTC hour
   - Else → all hours allowed
2. **Weekend check**: If `weekendPause` is `true` and agent has no open
   positions and it's the weekend → skip tick
3. **Regime check** (optional): If configured, skip when market regime is
   unfavourable
4. **Context hash** (optional): Skip if market data hasn't changed

---

## Runtime Policy API

### Creating an agent

```http
POST /agents
Content-Type: application/json
Authorization: Bearer <token>

{
  "name": "my-agent",
  "prompt": "You are a momentum trader...",
  "style": "balanced",
  "runtimePolicyOverrides": {
    "scoutMaxTurns": 50,
    "weekendPause": false
  }
}
```

The response includes `resolvedRuntimePolicy` — the merged result.

### Reading effective policy

```http
GET /agents/:id
```

Returns the agent with `resolvedRuntimePolicy` in the response body.

### Updating

```http
PUT /agents/:id
{
  "style": "bold",
  "runtimePolicyOverrides": {
    "scoutMaxTurns": null       // null → clear override, revert to style default
  }
}
```

### Reading operator ceilings

```http
GET /agents/risk-defaults
```

Returns `runtimePolicyCeilings` — the absolute platform maximums.

---

## Source Files

| Layer | File(s) |
|-------|---------|
| Style defaults (frontend) | `apps/web/src/features/agents/style-mapping.ts` |
| Style defaults (backend) | `packages/domain/src/config/schema.ts` → `AGENT_STYLE_RUNTIME_DEFAULTS` |
| Overrides schema | `packages/domain/src/config/schema.ts` → `AgentRuntimePolicyOverridesSchema` |
| Operator ceilings | `packages/domain/src/config/schema.ts` → `RUNTIME_POLICY_CEILINGS` |
| Policy resolver | `packages/domain/src/config/schema.ts` → `resolveAgentRuntimePolicy()` |
| Tick thinking | `apps/worker/src/tick-thinking.ts` |
| Tick gates | `apps/worker/src/tick-gates.ts` |
| Agent runtime | `apps/worker/src/agent.ts` |
| Reasoning params | `packages/llm/src/llm-provider.ts` → `resolveReasoningParams()` |
| Operator config | `config/default.yaml` → `llm` block |
