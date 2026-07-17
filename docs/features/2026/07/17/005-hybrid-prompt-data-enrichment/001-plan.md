# 005 — Hybrid Prompt Data Enrichment

**Status:** Planned  
**Created:** 2026-07-17  
**Depends on:** [003-prompt-context-enrichment](../../07/03/003-prompt-context-enrichment/001-plan.md) (implemented), [002-hybrid-agent-redesign](../../06/22/002-hybrid-agent-redesign/001-plan.md) (implemented)

## Problem

The hybrid evaluator prompt (`buildHybridPrompt`) gives the LLM a table of
scanner signals plus bare portfolio context. But it withholds data that the
judge agent receives via tools — venue intelligence (funding rates, open
interest, volume), rich exit-review context, and scanner rejection landscape.
The hybrid agent cannot call tools, so missing data means missing reasoning
surface.

The static prompt file at `.ignore/product/prompts/trading/hybrid-system-prompt.md`
is stale — it shows a bare-bones prompt that doesn't match what
`buildHybridPrompt()` actually generates. The scout prompt's escalation criteria
are similarly vague ("only escalate when there is good reason").

## Design Principle

**Data-in, not policy-in.** Every enrichment must answer "what does the agent
need to *know*?" — not "what should the agent *do*?" The agent's goal text and
creator-specified constraints are the sole source of trading policy
(see `AGENTS.md` — Agent Mode Purity, and `docs/tech/agents/skill-authoring.md`).

Concretely this means:
- ✅ Show funding rates, volume, open interest — data the agent can reason about.
- ✅ Show P&L on exit candidates — factual state of open positions.
- ✅ Show *why* instruments were rejected — market landscape context.
- ❌ Do NOT prescribe confidence thresholds, sizing formulas, or stop-loss percentages.
- ❌ Do NOT inject behavioral rules like "skip when regime is BLOCK."

## Goals

### Hybrid evaluator prompt (`buildHybridPrompt`)

1. **Venue intelligence.** Inject funding rate, 24h change, 24h volume, and open
   interest for each signal instrument and each open position. This is data the
   judge receives via `get_funding_rates` / venue-intelligence context blocks;
   the hybrid agent has no tool access, so it must be pre-injected.

2. **Richer exit review.** The exit review table currently shows only RSI and a
   signal note. Cross-reference `openPositions` to add unrealized P&L, hold
   duration, and current price — all already in runtime state, just not rendered
   in the exit section.

3. **Scanner rejection landscape.** The prompt says "17 rejected (3 passed)"
   but not *why*. Surface a breakdown of rejection categories from
   `symbolOutcomes` (unsupported, empty candles, transient failures) so the
   agent can assess the broader market landscape.

4. **Optional `reason` field in response schema.** Add `reason?: string` to
   `HybridAgentDecisionSchema`. The ADR cites auditability as a benefit of the
   single-shot path; this delivers it without influencing behavior.

### Scout prompt (`buildScoutSystemPrompt`)

5. **Concrete escalation triggers.** Replace the vague "only escalate when there
   is good reason" with an enumeration of *what data events constitute good
   reason* — scanner signals present, exit advisories, regime changes, wake
   signals. This describes *what exists*, not *what to do.*

### Static files

6. **Update or remove stale prompt files.** `.ignore/product/prompts/trading/hybrid-system-prompt.md`
   does not reflect the actual generated prompt. Either sync it or replace it
   with a pointer to `buildHybridPrompt()` as the source of truth.

## Non-Goals

- Do NOT add confidence thresholds, sizing formulas, stop-loss guidance, or
  any other prescriptive rules to prompts.
- Do NOT change the judge prompt (already enriched via 003-prompt-context-enrichment).
- Do NOT add tool access to the hybrid evaluator path.
- Do NOT widen `HybridAgentDecisionSchema` beyond the optional `reason` field.
- Do NOT change the `submit_decision` contract or engine intake path.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Venue intelligence data source | `state.metrics.venueSignals`, filtered to scan-signal and open-position instruments only | Already fetched and structured. No new I/O. |
| Venue intelligence scope | Signal instruments + open positions only, not all traded instruments | Keeps prompt compact. The agent only needs context on what it might trade. |
| Exit review enrichment source | Cross-reference `PositionIndicatorUpdate.symbol` ↔ `RuntimePositionSnapshot.instrumentId` | Both already in `HybridPromptInput`. No new data plumbing. |
| Rejection landscape source | `TechnicalScanState.symbolOutcomes` — count by `CandleFetchStatus` | Already in scan state. Just needs rendering. |
| `reason` field | Optional, appended to `HybridAgentDecisionSchema` with `z.string().optional()` | Backward-compatible. Runtime ignores it during submission; logs/persists for audit. |
| Scout escalation enumeration | Add as a list of event types, not thresholds | "Scanner signals present" is factual; "≥0.70 confidence" is prescriptive. |
| Stale static file | Sync to reflect actual `buildHybridPrompt` output | Easier to maintain as living documentation than to remove and lose the reference point. |

## Design

### Phase 1 — Venue intelligence injection

**File:** `apps/worker/src/hybrid-agent-prompt.ts`

Extend `HybridPromptInput`:

```typescript
export interface HybridPromptInput {
  // ... existing fields ...
  /** Venue intelligence for signal and open-position instruments. */
  venueSignals?: RuntimeVenueSignal[];
}
```

In `buildHybridPrompt`, after the Technical Scan Results section, add:

```
## Venue Intelligence
| Instrument | Funding Rate | 24h Change | 24h Volume | Open Interest |
|------------|-------------|------------|------------|---------------|
| LIT-PERP | 0.001% | +12.3% | $45.2M | 2.1M |
```

Filtering rules:
- Only include instruments that appear in the signal table OR the open positions table.
- Skip instruments where venue intelligence is unavailable or stale.
- If no venue intelligence is available for any relevant instrument, omit the section entirely.

In `apps/worker/src/hybrid-agent-evaluator.ts`, pass `state.metrics.venueSignals`
into the prompt input:

```typescript
const promptInput: HybridPromptInput = {
  // ... existing fields ...
  venueSignals: state.metrics.venueSignals,
};
```

### Phase 2 — Richer exit review

**File:** `apps/worker/src/hybrid-agent-prompt.ts`

Currently the exit review renders from `scan.positionIndicators`:

```
| Instrument ID | Side | Entry | RSI | Signal Note |
```

Enrich by cross-referencing `openPositions` (already in `HybridPromptInput`):

```
| Instrument ID | Side | Entry | Current | P&L | Hold | RSI | Signal Note |
```

Mapping rules:
- Match `positionIndicators[].symbol` to `openPositions[].instrumentId` (with fallback to symbol match).
- `Current` = `openPositions[].entryPrice` adjusted by `unrealizedPnlUsd` / size, or direct from `PositionIndicatorUpdate.currentPrice` if available.
- `P&L` = `openPositions[].unrealizedPnlUsd` (formatted via `fmtUsd`).
- `Hold` = `openPositions[].holdDurationMinutes` (formatted as e.g. `45m`).
- If no matching open position is found, show `—` for the enriched columns (graceful degradation).

### Phase 3 — Scanner rejection landscape

**File:** `apps/worker/src/hybrid-agent-prompt.ts`

Replace the current bare summary line:

```
### Rejected
20 instruments scanned, 17 rejected (3 passed filters)
```

With a categorized breakdown derived from `scan.symbolOutcomes`:

```
### Rejected
20 instruments scanned, 17 rejected (3 passed filters)
Rejection breakdown: 8 unsupported, 5 empty candles, 4 fetch failures
```

Derivation from `CandleFetchStatus`:
- `'unsupported'` → "unsupported" (venue doesn't list this instrument)
- `'eligible_empty'` → "no candle data" (instrument exists but has no recent candles)
- `'transient_failure'` → "fetch failure" (API error, rate limit, timeout)

If `symbolOutcomes` is empty or unavailable, fall back to the current bare summary.

### Phase 4 — Optional `reason` field

**File:** `packages/domain/src/agent-protocol.ts`

```typescript
export const HybridAgentDecisionSchema = z.object({
  instrumentId: z.string().min(1).optional(),
  symbol: z.string().min(1).optional(),
  intent: z.enum(['go_long', 'go_flat', 'skip', 'hold']),
  sizeUsd: z.number().optional(),
  reason: z.string().optional(),
}).refine((value) => value.instrumentId !== undefined || value.symbol !== undefined, {
  message: 'instrumentId or symbol is required',
});
```

**File:** `apps/worker/src/hybrid-agent-prompt.ts`

Update the example JSON in the prompt instructions to show `reason` as optional:

```json
[{"instrumentId":"SOL-PERP","intent":"go_long","sizeUsd":50,"reason":"high confidence, strong volume"},
 {"instrumentId":"ETH-PERP","intent":"skip","reason":"low confidence (0.40)"},
 {"instrumentId":"BTC-PERP","intent":"go_flat","reason":"stop loss triggered"}]
```

No runtime changes needed — `reason` is carried through `HybridAgentDecision`
and available for logging/audit but not consumed by the submission path.

### Phase 5 — Scout prompt escalation enumeration

**File:** `apps/worker/src/scout-dispatch.ts`

Replace:

```
Only escalate when there is good reason for agent "..." to act this tick.
```

With:

```
Escalate when one or more of the following are present this tick:
- Scanner signals are available (entry candidates or exit advisories)
- A watch threshold was triggered
- A regime change was detected
- A discovery delta event fired
- The reminder context requires action

Otherwise respond with hold.
```

This enumerates *data events* the scout can observe, not *thresholds* it must
evaluate. The scout's `readOnlyTools` already give it access to check these.

### Phase 6 — Static file hygiene

**File:** `.ignore/product/prompts/trading/hybrid-system-prompt.md`

Update to reflect the actual output of `buildHybridPrompt()` — include the
sections that are actually generated (Open Positions, Agent Memory, Recent Agent
Decisions, Technical Scan Results with regime, Positions Flagged for Exit
Review, size recommendations with `fmtUsd` formatting). Add a header comment:

```markdown
<!--
  This file reflects the output of buildHybridPrompt() in
  apps/worker/src/hybrid-agent-prompt.ts.
  It is a living reference — if you change the builder, update this file.
-->
```

## Implementation Phases

| Phase | Description | Files | Effort |
|---|---|---|---|
| 1 | Venue intelligence injection | `hybrid-agent-prompt.ts`, `hybrid-agent-evaluator.ts` | Small |
| 2 | Richer exit review | `hybrid-agent-prompt.ts` | Small |
| 3 | Scanner rejection landscape | `hybrid-agent-prompt.ts` | Trivial |
| 4 | Optional `reason` field | `agent-protocol.ts`, `hybrid-agent-prompt.ts` | Trivial |
| 5 | Scout escalation enumeration | `scout-dispatch.ts` | Trivial |
| 6 | Static file hygiene | `.ignore/product/prompts/trading/hybrid-system-prompt.md` | Trivial |

All phases are independent and can be implemented in any order. Phase 1 is the
only phase that requires plumbing a new field through the evaluator → prompt
builder boundary; the rest are local changes to existing rendering or schema.

## Test Plan

- **Phase 1:** Extend `hybrid-agent-evaluator.test.ts` — verify venue intelligence
  renders in prompt when `venueSignals` is passed; verify section is omitted when
  empty or no relevant instruments match.
- **Phase 2:** Extend existing exit review tests — verify P&L, hold duration, and
  current price columns render when open position data is available; verify `—`
  fallback when not matched.
- **Phase 3:** Unit test `buildHybridPrompt` with `symbolOutcomes` containing
  various `CandleFetchStatus` values — verify breakdown renders; verify fallback
  to bare summary when `symbolOutcomes` is empty.
- **Phase 4:** Add schema parse test for `reason` field (present, absent, empty
  string). Verify the field does NOT affect decision submission in evaluator tests.
- **Phase 5:** Unit test `buildScoutSystemPrompt` — verify escalation enumeration
  renders when venue/trading context is present; verify hold-is-default still
  appears.
- **Phase 6:** Manual review — compare static file against `buildHybridPrompt`
  output for a representative scan.
