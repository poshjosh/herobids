# 007 — LLM Cost Attribution Metrics

**Created:** 2026-07-11
**Status:** pending
**Depends on:** [Hybrid Mode Split](../../2026/07/11/004-hybrid-mode-split/001-plan.md)

## Problem

We can already measure coarse session cost from `billing_usage_events`, but we
cannot attribute that cost to the runtime path that produced it.

Today we can answer:

- total `llm.input_tokens`
- total `llm.cached_input_tokens`
- total `llm.output_tokens`
- total `llm.reasoning_tokens`
- total `agent.runtime_ms`

We cannot answer, with one clean query or evaluation export:

- how many LLM turns came from `scout`, `judge`, or hybrid single-shot
- which wake source caused those LLM turns
- how the applied reasoning level changed token spend
- whether `hybridMode = scanner_gated` reduced cost by suppressing non-scanner wakes or by shrinking per-turn payloads

That gap makes it hard to evaluate two current product questions:

1. how reasoning level affects cost
2. how `capabilityMode = intelligence` compares to `capabilityMode = hybrid` + `hybridMode = scanner_gated`

## Goals

Add enough instrumentation to answer the following from evaluation artifacts and
DB queries without manual log forensics:

1. LLM turn count by `llmPath`
2. LLM turn count by `triggerSource`
3. average and total input/output/cached/reasoning tokens by `llmPath`
4. average and total input/output/cached/reasoning tokens by `llmPath + triggerSource`
5. average and total tokens by applied reasoning level
6. session-level breakdowns that let us compare `intelligence` vs `hybrid/scanner_gated`

## Non-Goals

- No new end-user dashboard in this phase
- No billing price-model redesign
- No retroactive backfill of historical events
- No attempt to infer missing dimensions for already-recorded sessions

## Recommendation

Use the existing `billing_usage_events.metadata` JSONB field for attribution
dimensions instead of adding new top-level columns now.

This is the fastest path because:

- the table already supports metadata
- the worker already knows the needed runtime context at emission time
- the evaluation collector can aggregate JSONB dimensions without changing the commercial ledger model

If product later needs low-latency UI filtering over very large billing tables,
we can add promoted columns or JSONB indexes in a follow-up.

## Canonical Dimensions

### `llmPath`

Runtime path that produced the LLM usage event.

- `scout`
- `judge`
- `hybrid_single_shot`

### `triggerSource`

What actually caused the turn.

This plan should introduce a dedicated runtime enum, for example
`LlmTriggerSourceSchema`, with these exact values:

- `initial`
- `scheduled`
- `user_message`
- `reminder`
- `watch_threshold`
- `discovery_delta`
- `regime_change`
- `scanner`

Notes:

- Reuse the existing wake-source vocabulary exactly where it already exists in `AgentWakeSourceSchema`: `reminder`, `watch_threshold`, `discovery_delta`, `regime_change`, `scanner`
- Add only the three non-wake turn origins the runtime currently needs to classify: `initial`, `scheduled`, `user_message`
- Do not add `unknown`, `other`, or other catch-all values in this phase; the helper should always resolve one of the exact values above

### `triggerSource` precedence

When multiple stimuli are present on the same tick, stamp the source that most
directly opened the LLM path, using this fixed precedence:

1. `currentMarketWake.source` if present
2. `reminder` if `currentReminder` is present
3. `user_message` if inbound user messages are present
4. `initial` if this is the first tick of the session
5. `scheduled` otherwise

This makes attribution deterministic and aligns with current runtime behavior:

- market wakes already occupy `currentMarketWake`
- reminders are tracked separately from market wakes
- user messages can force meaningful work without any wake object
- first-tick and timer-driven turns remain distinguishable from wake-driven turns

### `reasoningLevel`

The resolved reasoning level used on that LLM call, not just the configured
default on the agent.

Examples:

- `none`
- `low`
- `medium`
- `high`

For adaptive scout/judge reasoning, this must reflect the final level passed to
the provider after runtime adaptation.

## Proposed Output Shape

### Billing event metadata

For every `llm.*` billing usage event, stamp metadata like:

```json
{
  "llmPath": "judge",
  "triggerSource": "scanner",
  "reasoningLevel": "medium",
  "capabilityMode": "hybrid",
  "hybridMode": "mixed",
  "sessionMode": "trading",
  "phaseTurnIndex": 0
}
```

Notes:

- `capabilityMode` and `hybridMode` are included so offline evaluation does not
  need to join other artifacts just to split cohorts
- `sessionMode` is optional but useful if agent sessions later cover more than trading
- `phaseTurnIndex` is optional and mainly useful for debugging, not primary reporting

### Runtime activity payloads

Extend runtime activity payloads so the human activity stream and the machine
cost ledger use the same attribution vocabulary.

- `TICK_STARTED.triggerSource: LlmTriggerSource`
- `TICK_SKIPPED.triggerSource: LlmTriggerSource`
- `LLM_DISPATCH.llmPath: 'scout' | 'judge' | 'hybrid_single_shot'`
- `LLM_DISPATCH.triggerSource: LlmTriggerSource`
- `LLM_DISPATCH.reasoningLevel?: string`
- `LLM_COMPLETED.llmPath: 'scout' | 'judge' | 'hybrid_single_shot'`
- `LLM_COMPLETED.triggerSource: LlmTriggerSource`
- `LLM_COMPLETED.reasoningLevel?: string`

Also emit `LLM_DISPATCH` and `LLM_COMPLETED` for the hybrid evaluator path.
Today only scout/judge are represented in the activity stream.

## Implementation Plan

## Part A — Runtime Attribution Contract

### Changes

| File | Action |
|------|--------|
| `packages/domain/src/agent-protocol.ts` | Add a dedicated `LlmTriggerSourceSchema` with exact values `initial | scheduled | user_message | reminder | watch_threshold | discovery_delta | regime_change | scanner` |
| `packages/domain/src/agent-protocol.ts` | Extend runtime activity payload schemas with `triggerSource`, `llmPath`, `reasoningLevel` |
| `apps/worker/src/agent.ts` | Add one helper to resolve the canonical `triggerSource` for a turn |
| `apps/worker/src/agent.ts` | Use the helper for `TICK_STARTED`, `TICK_SKIPPED`, scout dispatch/completion, judge dispatch/completion |
| `apps/worker/src/agent.ts` | Emit matching `LLM_DISPATCH` and `LLM_COMPLETED` events around the hybrid evaluator |

### Design notes

- Do not duplicate trigger-source derivation logic inline in multiple branches
- Prefer one helper that reads current wake state, reminder state, user-message presence, and initial/scheduled tick context
- The helper must implement the fixed precedence defined above and always return one of the eight exact enum values
- `llmPath` should be explicit even when `phase` already exists; `phase = hybrid` is not currently part of the schema and `llmPath` is the cleaner cross-path term

### Validation

- Scheduled intelligence tick stamps `triggerSource: 'scheduled'`
- Scanner-triggered hybrid evaluator stamps `llmPath: 'hybrid_single_shot'` and `triggerSource: 'scanner'`
- User-message-driven judge path stamps `triggerSource: 'user_message'`

## Part B — Billing Attribution Metadata

### Changes

| File | Action |
|------|--------|
| `apps/worker/src/usage-billing-service.ts` | Extend `LlmUsageInput` with `llmPath`, `triggerSource`, `reasoningLevel`, `capabilityMode`, `hybridMode` |
| `apps/worker/src/usage-billing-service.ts` | Persist those fields into `billing_usage_events.metadata` for all `llm.*` events |
| `apps/worker/src/agent.ts` | Pass attribution metadata for scout/judge billing calls |
| `apps/worker/src/agent.ts` | Pass attribution metadata for hybrid evaluator billing calls |

### Design notes

- No DB migration is required for the first pass because `billing_usage_events.metadata` already exists
- Keep idempotency keys unchanged; attribution metadata is descriptive and should not alter billing duplication semantics
- Stamp the same metadata on each split token event (`input`, `cached_input`, `output`, `reasoning`) so all aggregations stay simple

### Validation

- `recordLlmUsage()` writes metadata on every emitted usage event
- Cache-hit sessions still split into `llm.input_tokens` and `llm.cached_input_tokens`, both carrying identical attribution metadata
- Hybrid single-shot billing rows persist `llmPath: 'hybrid_single_shot'`

## Part C — Reasoning-Level Capture

### Changes

| File | Action |
|------|--------|
| `apps/worker/src/agent.ts` | Capture the resolved scout reasoning level used for the provider request |
| `apps/worker/src/agent.ts` | Capture the resolved judge reasoning level used for the provider request |
| `apps/worker/src/agent.ts` | Stamp `reasoningLevel: 'none'` for hybrid single-shot unless hybrid reasoning becomes configurable |

### Design notes

- Persist the effective reasoning level after adaptation, not merely the configured default
- This is required for trustworthy experiments when `adaptScoutReasoning` or `adaptJudgeReasoning` is enabled

### Validation

- Adaptive runs that escalate from `none` to `medium` are recorded as `medium`
- Non-thinking models or disabled reasoning runs stamp `none`

## Part D — Evaluation Collector and Artifacts

### Changes

| File | Action |
|------|--------|
| `apps/worker/src/agent-evaluation/collectors/evidence-assembler.ts` | Keep existing `costs.json` for backward compatibility |
| `apps/worker/src/agent-evaluation/collectors/evidence-assembler.ts` | Add a new `cost-attribution.json` artifact with grouped breakdowns |
| `apps/worker/src/agent-evaluation/run-evaluation.ts` | Register the new artifact in expected outputs if needed |
| `apps/worker/src/agent-evaluation/*` | Update tests that assert artifact names or contents |

### Proposed `cost-attribution.json`

```json
{
  "totalsByPath": [
    {
      "llmPath": "judge",
      "inputTokens": 12000,
      "cachedInputTokens": 3000,
      "outputTokens": 2500,
      "reasoningTokens": 800,
      "callCount": 14
    }
  ],
  "totalsByPathAndTrigger": [
    {
      "llmPath": "hybrid_single_shot",
      "triggerSource": "scanner",
      "inputTokens": 4000,
      "cachedInputTokens": 0,
      "outputTokens": 700,
      "reasoningTokens": 0,
      "callCount": 9
    }
  ],
  "totalsByReasoningLevel": [
    {
      "reasoningLevel": "medium",
      "inputTokens": 9000,
      "cachedInputTokens": 1000,
      "outputTokens": 2100,
      "reasoningTokens": 600,
      "callCount": 11
    }
  ]
}
```

### Design notes

- Do not remove or break `costs.json`; other consumers may rely on it
- `cost-attribution.json` should be the analysis-friendly export for new experiments
- Aggregation should query billing rows directly rather than reconstructing cost from activity events

### Validation

- Evaluation output includes both `costs.json` and `cost-attribution.json`
- A scanner-gated run shows hybrid single-shot rows grouped under `triggerSource: 'scanner'`
- An intelligence run shows scout/judge rows with scheduled or other wake sources as appropriate

## Part E — Tests

### Unit tests

| File | Coverage |
|------|----------|
| `apps/worker/src/usage-billing-service.test.ts` | metadata stamping on all emitted `llm.*` events |
| `apps/worker/src/agents/agent-protocol.test.ts` | schema accepts new payload fields |
| `apps/worker/src/agent.ts` tests | trigger-source derivation and hybrid activity emission |
| `apps/worker/src/agent-evaluation/collectors/evidence-assembler.test.ts` | grouped attribution export |

### Integration tests

- intelligence agent session emits scout/judge attribution rows
- scanner-gated hybrid session emits only `hybrid_single_shot` attribution rows for trading turns
- mixed hybrid session can emit both normal scout/judge and hybrid evaluator rows depending on wake source

## Acceptance Criteria

1. Every new `llm.*` usage event written by the worker includes `metadata.llmPath`.
2. Every new `llm.*` usage event written by the worker includes `metadata.triggerSource`, and the value is always one of: `initial`, `scheduled`, `user_message`, `reminder`, `watch_threshold`, `discovery_delta`, `regime_change`, `scanner`.
3. Every new `llm.*` usage event written by the worker includes `metadata.reasoningLevel` for scout/judge and a stable value for hybrid single-shot.
4. The activity stream emits hybrid LLM dispatch/completion events with the same attribution fields used by billing.
5. Evaluation runs export a `cost-attribution.json` artifact that groups token totals and call counts by path, by path+trigger, and by reasoning level.
6. We can answer both of these questions from one eval bundle without reading raw logs:
   - how reasoning level affected token cost
   - how `scanner_gated` changed cost relative to `intelligence`

## Risks

- Trigger attribution can become inconsistent if multiple code paths derive it independently. Centralise the logic.
- Historical eval bundles will remain coarse because existing billing rows do not carry the new metadata.
- If later product requirements need indexed cross-session analytics, JSONB-only storage may become too slow; treat that as a follow-up, not a blocker for this phase.

## Follow-Up Candidates

- Add a JSONB or promoted-column index if attribution queries become hot
- Surface attribution breakdowns in admin/API endpoints
- Add experiment helpers that annotate eval bundles with cohort metadata such as model, reasoning policy, and runtime mode