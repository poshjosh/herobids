# Epic A — Agent Cost Reduction Task List

**Epic:** A (Agent Cost Reduction)
**Plan:** [agent-cost-reduction-pipeline.md](../references/agent-cost-reduction-pipeline.md)
**Goal:** Reduce agent LLM costs by 60–90% without sacrificing decision quality.

---

## Tasks

### T1: Reorder prompt structure for cache hits

**Status:** not-started
**Approach:** End-to-end
**Effort:** Small (1 session)

Reorder `RUNTIME_CONTEXT_PROVIDERS` in `runtime-composition.ts` so static content (system prompt, skill definitions, tool schemas, playbook rules) is always first, dynamic content (positions, prices, regime) is always last. Remove any timestamps or per-tick noise from the static section.

**Files:** `apps/worker/src/runtime-composition.ts`
**Acceptance:** Static tokens appear before dynamic tokens in the composed prompt. No functional change to agent behavior. `pnpm lint` and `pnpm test` pass.

---

### T2: Gating framework + Regime gate

**Status:** not-started
**Approach:** End-to-end
**Effort:** Medium (1 session)
**Depends on:** None

Add a `shouldSkipTick(state): { skip: boolean; reason?: string }` function to `apps/worker/src/agent.ts` (or a new `tick-gates.ts`). Implement the first gate:

- **Regime Gate:** Call `evaluateRegime()` (already exists in `@herobids/market-data`). If regime is unfavorable AND agent has no open positions → skip tick.
- **Position bypass:** If agent has any open position, never skip (needs exit decisions).
- Log skipped ticks with reason for observability.

**Files:** `apps/worker/src/` (new `tick-gates.ts` or inline in `agent.ts`)
**Acceptance:** When regime is unfavorable and no positions exist, the LLM is not called. When positions exist, LLM is always called regardless of regime. Unit test covers both paths.

---

### T3: Context hash gate

**Status:** not-started
**Approach:** End-to-end
**Effort:** Medium (1 session)
**Depends on:** T2 (uses gating framework)

Add Gate 3 to the gating pipeline:

- Hash decision-relevant data: position side, price bucket (rounded to 0.5%), regime state, portfolio P&L bucket (rounded to nearest $10 or 1%).
- Store hash from previous tick in memory.
- If hash matches → skip LLM call, log "context unchanged."
- Every 10th tick, force an LLM call regardless (prevent drift).

**Files:** `apps/worker/src/tick-gates.ts`
**Acceptance:** Consecutive ticks with identical state do not fire LLM. After a price move exceeding the bucket, LLM fires. Force-fire every 10 ticks. Unit tests.

---

### T4: Session gate (trading hours)

**Status:** not-started
**Approach:** End-to-end
**Effort:** Small (1 session)
**Depends on:** T2 (uses gating framework)

Add Gate 1:

- Config field: `tradingHours` (optional). Default: always active (crypto 24/7).
- If configured, check current UTC hour against allowed hours.
- Weekend (Sat 00:00 – Sun 12:00 UTC) can optionally gate low-liquidity periods.
- Position bypass applies (same as T2).

**Files:** `apps/worker/src/tick-gates.ts`, config schema
**Acceptance:** Agent skips ticks outside configured hours unless holding positions. Config is optional — default is no session gating.

---

### T5: Adaptive tick interval

**Status:** not-started
**Approach:** End-to-end
**Effort:** Medium (1 session)
**Depends on:** T2 (uses gating framework)

Add Gate 4:

- Compute recent ATR from available candle data (Binance candles already available via `@herobids/market-data`).
- Define threshold relative to asset (e.g., < 0.3% hourly ATR = low vol).
- Low vol: double `TICK_INTERVAL_MS` for next cycle (max 2× base).
- High vol: halve interval (floor at base interval).
- Log interval changes.

**Files:** `apps/worker/src/tick-gates.ts`, agent tick scheduler
**Acceptance:** Interval adapts based on volatility. Low-vol periods produce fewer ticks. High-vol periods produce more. Log output shows interval changes.

---

### T6: Thinking-level parameter on @herobids/llm

**Status:** not-started
**Approach:** End-to-end
**Effort:** Medium (1 session)
**Depends on:** None (can parallel with T2-T5)

Extend `LlmRequest` in `packages/llm/src/llm-provider.ts`:

- Add `thinking?: 'none' | 'light' | 'deep'` to request interface.
- Anthropic mapping: `none` → omit; `light` → `budget_tokens: 2048`; `deep` → `budget_tokens: 10240`.
- OpenAI mapping: `none` → omit; `light` → `reasoning_effort: 'low'`; `deep` → `reasoning_effort: 'high'`.
- Others: silently ignore.
- When thinking enabled for Anthropic: override temperature to 1, inflate max_tokens.

**Files:** `packages/llm/src/llm-provider.ts`, types
**Acceptance:** Passing `thinking: 'light'` to Anthropic sends proper `budget_tokens`. Passing to OpenAI sends `reasoning_effort`. Passing to unknown provider is a no-op. Unit tests for all three paths.

---

### T7: Tick classification → thinking-level mapping

**Status:** not-started
**Approach:** End-to-end
**Effort:** Small (1 session)
**Depends on:** T6

In `runTick()`, after gating passes, classify the tick and set thinking level:

| Condition | Thinking |
|-----------|----------|
| No positions, regime favorable, nothing changed recently | `none` |
| Has positions, no significant change since last tick | `light` |
| Regime flip, large drawdown (>2%), user message received, new event | `deep` |

Pass the resolved thinking level to `callLlmProvider`.

**Files:** `apps/worker/src/agent.ts`
**Acceptance:** LLM calls include appropriate thinking level. Log shows classification reason. No behavior change in decision quality (thinking controls reasoning depth, not output format).

---

### T8: Scout mode — cheap model dispatch with restricted tools

**Status:** not-started
**Approach:** Vertical slice
**Effort:** Large (1–2 sessions)
**Depends on:** T6, T7

Implement the scout phase:

- Add a `scoutModel` field to agent config (defaults to cheapest available provider).
- Scout gets a compact prompt: recent context diff + "should we act or hold?"
- Scout tool policy: read-only tools only (no `submit_decision`, `create_bot`, `stop_bot`, etc.).
- Scout returns structured output: `{ disposition: 'hold' | 'escalate', reason?: string }`.
- If `hold` → tick ends, no judge call.
- If `escalate` → proceed to judge (existing full flow).

**Files:** `apps/worker/src/agent.ts`, tool policy config, agent config schema
**Acceptance:** Scout calls use cheap model. Scout cannot invoke write tools (enforced, not prompt-only). `hold` disposition ends the tick without a judge call. `escalate` triggers full judge flow.

---

### T9: Judge escalation path

**Status:** not-started
**Approach:** Vertical slice
**Effort:** Medium (1 session)
**Depends on:** T8

Complete the judge phase:

- Judge receives scout's `reason` as additional context in the prompt.
- Judge uses premium model with `thinking: 'deep'` (or per tick classification).
- Judge has full tool access.
- Track and log scout→judge escalation rate for tuning.
- Metric: `agent.escalation_rate` (target: 15–25% of ticks escalate).

**Files:** `apps/worker/src/agent.ts`
**Acceptance:** Judge prompt includes scout handoff context. Metrics show escalation rate. Only escalated ticks incur premium model cost.

---

### T10: Context diffing (incremental prompts)

**Status:** not-started
**Approach:** End-to-end
**Effort:** Medium (1–2 sessions)
**Depends on:** T1, T3 (uses context hash infrastructure)

Instead of sending full market state every tick:

- Store previous tick's context snapshot in memory.
- Compute human-readable diff: "BTC +1.2%, SOL -0.5%, funding flipped negative."
- If diff is small (< 200 tokens), send diff-mode prompt.
- Every 10th tick, send full context (prevents model drift).
- Falls back to full context if diff exceeds threshold.

**Files:** `apps/worker/src/runtime-composition.ts`, new `context-diff.ts`
**Acceptance:** Diff-mode ticks use measurably fewer input tokens (log token count). Full-context ticks fire every 10th cycle. Agent decisions remain coherent across diff/full modes.

---

### T11: Cost presets and daily spend budget

**Status:** not-started
**Approach:** End-to-end
**Effort:** Medium (1 session)
**Depends on:** T5, T6, T7 (uses interval + thinking level)

Add cost presets to agent config:

| Preset | Daily budget | Tick interval | Model | Gating | Thinking |
|--------|-------------|---------------|-------|--------|----------|
| minimal | $1–3 | 30 min | Cheap | All gates | none |
| standard | $5–10 | 15 min | Mid-tier | Regime + hash | light |
| premium | $15–30 | 5 min | Premium | Hash only | deep |
| custom | User-set | Derived | Derived | Derived | Derived |

For custom: derive tick interval and model tier from budget constraint.

**Files:** Agent config schema, `apps/worker/src/agent.ts` (or config resolver)
**Acceptance:** Setting `costPreset: 'minimal'` on an agent configures all derived parameters. Custom budget correctly derives interval. Exposed via existing agent config API.

---

## Parallelization Notes

- **T1** and **T6** can start in parallel (no dependency).
- **T2–T5** are sequential (each gate builds on the framework from T2).
- **T6–T7** are sequential.
- **T8–T9** are sequential (scout before judge).
- **T10** can start after T1 + T3 are done.
- **T11** can start after T5 + T7 are done.

```
T1 (cache structure) ──────────────────────────────┐
T6 (thinking param) → T7 (tick classification)     │
T2 (gating + regime) → T3 (hash) → T4 (session)   ├→ T10 (diffing)
                     → T5 (adaptive interval) ─────├→ T11 (presets)
                                                   │
T8 (scout) → T9 (judge) ──────────────────────────┘
```
