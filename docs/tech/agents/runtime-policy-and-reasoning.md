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
| **Daily spend budget** | $1 | $5 | $30 |
| **Escalation policy** | uncovered_or_triggered | always | always |
| `scoutMaxTurns` | 50 | 50 | 50 |
| `judgeMaxTurns` | 500 | 500 | 500 |
| `scoutMaxTokens` | 10 240 | 16 384 | 24 576 |
| `judgeMaxTokens` | 26 624 | 36 864 | 49 152 |
| `lightThinkingTokens` | 2 048 | 4 096 | 8 192 |
| `deepThinkingTokens` | 10 240 | 20 480 | 32 768 ¹ |
| `scoutOutputReserveTokens` | 4 096 | 4 096 | 4 096 |
| `judgeOutputReserveTokens` | 16 384 | 16 384 | 16 384 |
| `scoutReasoning` | none | low | medium |
| `judgeReasoning` | low | medium | high |
| `adaptScoutReasoning` | true | true | true |
| `adaptJudgeReasoning` | true | true | true |
| `allowedHoursUtc` | [] (all) | [] (all) | [] (all) |
| `weekendPause` | false | false | false |
| `maxHistoryMessages` | 20 | 40 | 80 |
| `maxHistoryTokens` | 40 000 | 80 000 | 160 000 |
| `maxRecentToolMessages` | 6 | 12 | 24 |
| `maxToolResultChars` | 4 000 | 8 000 | 16 000 |
| `maxVisibleToolSchemas` | 64 | 128 | 256 |
| `maxContextBlockChars` | 4 000 | 8 000 | 16 000 |
| `toolResultFullRetentionTurns` | 3 | 5 | 10 |
| `toolResultMaxStaleChars` | 500 | 1 000 | 2 000 |
| `maxHoldDurationMs` | 27 000 000 | 5 400 000 | 600 000 |

¹ new bold `deepThinkingTokens` would be 40 960 (former bold 20 480 × 2) but is
clamped to the `deepThinkingTokens` ceiling of 32 768.

Cost preset, tick interval and max hold are paired per style and follow the
strategy preset tiers: careful → minimal (economy), balanced → standard,
bold → premium. Max hold is a multiple of the tick (careful 5×, balanced 3×,
bold 1×). Budget fields (history, tokens, tool schemas) step up per style, with
bold's doubled and clamped to the operator ceilings. The daily spend hints
($1 / $5 / $30) are the targets and are independent of the preset's own default
budget.

A missing or invalid style falls back to **balanced**.

### Tick interval for non-trading agents

The style tick interval above applies to agents with a trading skill. For an
agent without one, the tick is resolved by `resolveEffectiveTickIntervalMs`
(`packages/domain/src/config/agent-schedule.ts`) with this precedence:

1. **Stored value** (`agents.tick_interval_ms` not null): used as is, source `user`.
2. **Non-trading and unset**: the operator default
   `agentRuntime.nonTradingDefaults.tickIntervalMs` (24 h by default), source
   `non_trading_default`.
3. **Trading and unset**: no value (source `unset`); the style / cost-preset
   cadence applies.

How it behaves:

- The API stores `null` when `tickIntervalMs` is omitted on create. It never
  writes the default into the column.
- Agent responses carry `effectiveTickIntervalMs` and `tickIntervalSource`, so
  clients show the effective cadence without owning the rule. The web form does
  not pre-fill or classify.
- The worker resolves the non-trading default at launch
  (`apps/worker/src/agents/agent-session-manager.ts`) and passes it to the
  container as `agentConfig.tickIntervalMs`. Changing the operator default takes
  effect for unset agents on their next launch.
- The API and worker both derive trading capability from the agent's skills: the
  API from the skill ids, the worker from the resolved skill descriptor. They can
  disagree for a skill whose stored capability families are missing; the worker's
  answer decides the launch cadence.

Existing agents (no data migration):

- Non-trading agents created before this change have `tick_interval_ms = 86400000`
  stored. That reads as an explicit `user` value and gives the same 24 h cadence,
  even if the operator default is later changed.
- Adding a trading skill later replaces a stored tick with the style cadence only
  if it still equals the current operator default. A legacy 24 h kept after the
  operator default changed is not replaced and stays as an explicit tick.
- The replacement only runs when the PATCH omits `tickIntervalMs`. The web edit
  form omits the field while it is untouched, so a legacy 24 h agent that gains a
  trading skill moves to the style cadence. A tick sent in the request, even one
  equal to the stored value, is treated as a deliberate choice and is validated
  against the max hold as is (the max-hold check runs on the post-replacement
  tick). An edit that clears the field sends `null`.
- Removing the last trading skill changes nothing about the tick (current
  behaviour, no reverse replacement). A stored explicit tick, such as the style's
  30 min, stays, so the agent now runs a non-trading workload at a fast cadence
  until the creator edits or clears it. A stored `null` resolves to the operator
  default (24 h) at the next launch, with the max hold validated against that.
- Their edit form shows 24 h as a filled value. A new non-trading agent has
  `null`, so its edit form shows an empty field with the effective default notice.
- Old non-trading agents with a null tick now get the operator default at launch
  (a change from running the preset cadence). Trading agents with a null tick keep
  the style / preset cadence.
- A migration that nulls old 24 h values was rejected because it could
  reinterpret a deliberate 24 h choice.

### Output token limits: `scoutMaxTokens`, `judgeMaxTokens` and the operator `llm.maxTokens`

`scoutMaxTokens` and `judgeMaxTokens` are the output-token limit of each scout and judge model call.
At agent startup `apps/worker/src/agent.ts` replaces the operator default (`llm.maxTokens`, passed to
the container as `LLM_MAX_TOKENS`) with the agent's resolved value for the scout and, through
`resolveJudgeMaxTokens` (`apps/worker/src/judge-max-tokens.ts`), for the judge. The operator value
still applies to the hybrid evaluator and to an agent that has no resolved policy. (Before bug
2026-11-17/005 the judge ignored `judgeMaxTokens` and always used the operator value.)

The limit is shared with reasoning. On OpenRouter, reasoning tokens count against it, and at effort
`high` about 80% of it can go to reasoning, so the room left for text and
tool calls is a fraction of the figure shown. A response that spends the whole limit ends with
`finish_reason: "length"`, and any tool call in it is cut off.

To leave room for an answer, the resolved limits keep an output reserve after thinking:
`judgeMaxTokens >= deepThinkingTokens + judgeOutputReserveTokens` and
`scoutMaxTokens >= round((lightThinkingTokens + deepThinkingTokens) / 2) + scoutOutputReserveTokens`
(the scout limit is sized for `medium`, its highest reasoning level, whose token budget is the midpoint of
light and deep, so raising `deepThinkingTokens` also raises the scout minimum). `resolveAgentRuntimePolicy` raises a
lower value (for example an older override) to that sum, capped at the ceiling, and the worker logs it. Each
call is then clamped to the model's maximum output and the call timeout scales with the limit. The reasoning
level is never lowered to fit (D21): when the reserve no longer fits after the clamp the level is kept and
logged. A call that is still cut off is retried at the same level with a hint to think briefly
(`llm.lengthRecovery`). Details:
[Agent Runtime: Output Budget And Length Recovery](../../best-practices/agent-runtime.md#output-budget-and-length-recovery).

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
the same values** (`DEFAULT_SCOUT_MAX_TURNS` / `DEFAULT_JUDGE_MAX_TURNS` in
`packages/domain/src/config/schema.ts`) so whichever one wins produces identical
numbers and nothing is silently contradictory:

- `scoutMaxTurns`: ceiling 500; all styles 50; operator `llm.scout.maxTurns` 50.
- `judgeMaxTurns`: ceiling 10 000; all styles 500; operator `llm.judge.maxTurns` 500.

**What the numbers mean in time.** A turn is one model call plus the tool calls it
requests. At an assumed 20 seconds per turn:

| Cap | Turns | Time at 20 s per turn |
|-----|:-----:|-----------------------|
| scout | 50 | 1 000 s, about 17 minutes |
| judge | 500 | 10 000 s, about 2 hours 47 minutes |

The real pace depends on the model and tools. On the local stack we saw about 4 s
per turn on a hosted Haiku-class model and about 60 s per turn on a local 35B model
served by Ollama (the judge cap is then about 8 hours). The cap counts turns, not
time.

**Why uniform:** turn caps are runaway-loop protection, not behavioural tuning, so
they are the same across styles; only token/history/reasoning budgets stay
graduated. The previous values (scout 499, judge 9 999) were effectively unlimited
(a runaway judge loop could run for days). When the judge loop hits its cap it ends
without a wrap-up step and the tick is reported as degraded
(`llm.tool_loop_limit`), so the cap should sit well above normal run length. A
per-agent override (`runtimePolicyOverrides.scoutMaxTurns` / `judgeMaxTurns`) can
still raise or lower it, up to the ceilings above.

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
| `scoutMaxTokens` | 28 672 |
| `judgeMaxTokens` | 65 536 |
| `lightThinkingTokens` | 8 192 |
| `deepThinkingTokens` | 32 768 |
| `scoutOutputReserveTokens` | 8 192 |
| `judgeOutputReserveTokens` | 32 768 |
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
| `medium` | Moderate reasoning (midpoint of light and deep, e.g. 6 144 for careful) |
| `high` | Deep reasoning (e.g. 10 240+ tokens) |

The actual token budgets come from the **style default** `lightThinkingTokens`
(for `low`) and `deepThinkingTokens` (for `high`). Medium averages the two.

### What runs equals what the user chose (D20)

`scoutReasoning` and `judgeReasoning` are the user's levels. The platform never runs above them, and never
lowers them for its own reasons (no output-budget or length-recovery step-down, D21). One function,
`resolveRunReasoning()` in `apps/worker/src/tick-thinking.ts`, maps the user's level `L` for both the scout
and the judge:

| Run | Adaptive on (`L` is a maximum) | Adaptive off |
|-----|:------------------------------:|:------------:|
| Important | `L` | `L` |
| Lighter | one step below `L` (`high` → `medium` → `low` → `none`) | `L` |
| Routine | `none` | `L` |

Adaptive is `adaptScoutReasoning` / `adaptJudgeReasoning` (default `true`). A user who picks `medium` gets
`medium` on an important run, never `high`.

#### Where the level comes from (D22)

An agent with no explicit level uses its style default (table above): careful scout `none`, judge `low`;
balanced scout `low`, judge `medium`; bold scout `medium`, judge `high`. Token limits stay sized for the
highest level a user may choose, so an explicit level is kept and honoured exactly. The worker falls back to
the balanced defaults only when no resolved policy reached it.

The create screen and the edit modal show the style default as the "Style default (…)" option. The user's
Settings page offers "Agent style default" for each level; that saves `null`, so a new agent keeps its style
default. A level chosen there is copied into a new agent's overrides when it is created; it does not change
existing agents.

#### Model output warning (D21 C)

The AI section of the create screen and the edit modal warns, without blocking, when the thinking budget for
the chosen (or style default) reasoning level plus that role's output reserve is more than the selected economy
or premium model's maximum output (`findModelMaxOutputTokens`, `DEFAULT_MAX_OUTPUT_TOKENS_BY_MODEL` in
`packages/domain/src/config/schema.ts`). The thinking budget per level is: none 0, low light, medium halfway
between light and deep, high deep. Only models in the built-in table are checked; operator entries in
`llm.maxOutputTokensByModel` and the default for unknown models are not known to the web. The model maximum is
matched the same way as in the worker (`resolveModelMaxOutputTokens` in `packages/llm/src/output-budget.ts`).
For Claude models the thinking size is chosen by the model, so this check is an approximation.

#### Run classification: `classifyTickRun()`

Computed once per tick (when either adaptive flag is on) and shared by the scout and the judge. The first
matching condition names the reason:

| Condition | Run | Reason |
|-----------|:---:|--------|
| Market regime just flipped | important | `regime_flip` |
| Drawdown ≤ `drawdownThresholdPct` | important | `drawdown_threshold` |
| A protective watch triggered, or an open position has no protection or coverage | important | `protection_gap` |
| The owner sent a message (or one was flagged by the wake poll) | important | `user_message` |
| A market wake started the tick (watch, scanner or other trading trigger) | important | `market_wake` |
| A reminder wake fired (work the agent scheduled for itself) | important | `work_wake` |
| The session's first tick that reaches the scout or judge (gates can skip earlier ticks), or a resumed run that re-evaluates in full | important | `first_run` |
| A peer message, a child's report, or a creator's message to its child (a user message sent by an agent) | important | `agent_message` |
| Has open positions | lighter | `open_positions` |
| None of the above | routine | `routine_tick` |

The wake poll cannot tell who sent a pending message, so a peer message flagged but not yet read counts as
`user_message`. Other runtime events (fills, reconciliation notices) do not make a run important on their own.
`buildTickRunInput()` maps the tick's facts to the classifier input. For the judge, a premium cost profile (`costProfile.defaultThinking === 'deep'`) makes every run
important (`cost_profile_premium`), still never above `L`. With adaptive off the reason is `adaptive_off`.

#### Provider parameters: `resolveReasoningParams()`

`resolveReasoningParams()` (in `packages/llm/src/llm-provider.ts`) maps the level to the request:

- **Effort-based models** (Claude Fable 5, Sonnet 5, Opus 4.7+, other Claude): `{ effort: level }`.
- **Token-budget models** (everything else): `{ max_tokens: <budget> }` with `low` = `lightThinkingTokens`,
  `medium` = their midpoint, `high` = `deepThinkingTokens` (`resolveReasoningBudgetTokens`; the output
  budget checks the reserve with the same numbers).
- **`none`** is an explicit "reasoning off", `{ enabled: false }`:
  - OpenRouter receives `reasoning: { enabled: false }`. Omitting the parameter would let the model's default
    apply, which is on for many reasoning models.
  - Anthropic native receives no `thinking` field, which is its off.
  - Other OpenAI-compatible providers (OpenAI, DeepSeek, Google, Ollama) receive no reasoning parameter,
    because no off switch is accepted by every model there (a non-reasoning model rejects `reasoning_effort`).
    The provider's default applies, so a reasoning model there may still think.
  - Adaptive-thinking-only models (Claude Fable) cannot turn thinking off: `none` runs at `{ effort: 'minimal' }`.
  - Mandatory-reasoning models (`isReasoningMandatoryModel`: OpenAI o1/o3/o4, GPT-5 base/mini/nano/codex,
    DeepSeek R1, Gemini 2.5 Pro) reject an off: `none` runs at their lowest effort, `{ effort: 'low' }`
    (`minimal` is not valid for the o-series). The list is kept short on purpose.
  - If OpenRouter still answers 400 because reasoning is mandatory, the call is retried once without the
    `reasoning` parameter (the model's default applies). The worker remembers the rejected model and reasoning
    pair for the rest of the process and omits `reasoning` for it from then on (one warning per pair).
- The **hybrid evaluator** (single-shot trading decisions) sends no reasoning parameter at all, so the
  provider's default applies.

#### Where to see it (D23)

The judge logs `Resolved tick thinking level` once per judge run with `reasoningLevel`, `reasoningReason`,
`reasoningCeiling` (the user's level) and `adaptiveReasoning`. The scout's `Scout held the tick` and
`Scout escalated to judge` lines carry the same fields. They are also on every `agent.llm.completed` event,
scout and judge, together with `reasoningSent`: what the provider was last sent (an effort, `off`,
`max_tokens:<n>`, `enabled`, or `omitted`), so a mandatory-reasoning fallback is visible next to the level.

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
