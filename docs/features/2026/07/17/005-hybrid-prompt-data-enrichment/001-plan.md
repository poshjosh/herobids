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

The scout prompt's escalation criteria are similarly vague
("only escalate when there is good reason").

> **Note:** Files under `.ignore/` (including `.ignore/product/prompts/trading/`)
> are snapshots and developer references, not runtime artifacts. The runtime
> `buildHybridPrompt()` in `apps/worker/src/hybrid-agent-prompt.ts` is the sole
> authoritative source. Do NOT update `.ignore/` files as part of this plan.

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

5. **Concrete escalation triggers (trading agents only).** When the agent has
   trading capability, replace the vague "only escalate when there is good
   reason" with an enumeration of *what data events constitute good reason* —
   scanner signals present, exit advisories, regime changes, wake signals. This
   describes *what exists*, not *what to do.* For non-trading agents, keep the
   existing text unchanged.

## Non-Goals

- Do NOT add confidence thresholds, sizing formulas, stop-loss guidance, or
  any other prescriptive rules to prompts.
- Do NOT change the judge prompt (already enriched via 003-prompt-context-enrichment).
- Do NOT add tool access to the hybrid evaluator path.
- Do NOT widen `HybridAgentDecisionSchema` beyond the optional `reason` field.
- Do NOT change the `submit_decision` contract or engine intake path.
- Do NOT update any files under `.ignore/` — these are snapshots, not runtime
  artifacts. The runtime builders are the sole authoritative sources.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Venue intelligence data source | `state.metrics.venueSignals`, filtered to scan-signal and open-position instruments only | Already fetched and structured. No new I/O. |
| Venue intelligence table key | `instrumentId` (mapped from `RuntimeVenueSignal.instrument` via `pricingIdentities` sidecar) | Every other table uses `instrumentId` as its row key. Using the same key eliminates ambiguity — the agent copies the value directly into its JSON response. `RuntimeVenueSignal.instrument` stores the base symbol (e.g. `"BTC"`), not `instrumentId` (e.g. `"BTC-PERP"`). The `pricingIdentities` sidecar on `TechnicalScanState` provides the `instrumentId → symbol` mapping needed to resolve the match. |
| Venue intelligence scope | Signal instruments + open positions only, not all traded instruments | Keeps prompt compact. The agent only needs context on what it might trade. |
| Venue intelligence staleness | Show with staleness marker (e.g. `0.010% (stale 8m)`), consistent with `formatFreshness` convention in judge prompt. If entirely unavailable, show `—`. | The agent can weigh staleness against signal confidence. Consistent with how the judge prompt renders freshness. |
| Exit review enrichment source | Cross-reference `PositionIndicatorUpdate.symbol` ↔ `RuntimePositionSnapshot.instrumentId` | Both already in `HybridPromptInput`. No new data plumbing. |
| Rejection landscape source | `TechnicalScanState.symbolOutcomes` — count by `CandleFetchStatus` | Already in scan state. Just needs rendering. |
| Empty `symbolOutcomes` | Fall back to bare summary (scanned/rejected/passed counts). No warning. | Edge case, not a data integrity issue. Summary counts remain accurate. |
| `reason` field | Optional (`z.string().optional()`). Discarded after parsing — NOT attached to `agent.decision.submit`. | Backward-compatible. The full LLM response is already logged by the evaluator, so `reason` is preserved for audit without widening the protocol schema. |
| `promptStyle` gate | Always-on, no toggle. | These are strictly additive data fields within existing prompt sections. Unlike 003's memory injection (which restructured prompt composition), these enrichments just fill in columns that were previously `—`. |
| Scout escalation enumeration | Add as a list of event types, not thresholds. Gated behind `hasTradingCapability`. | "Scanner signals present" is factual; "≥0.70 confidence" is prescriptive. Non-trading agents keep the existing vague text. |
| `.ignore/` files | Do NOT update. | The runtime builders are authoritative. `.ignore/` files are developer snapshots; keeping them in sync is low-value maintenance overhead. |

## Design

### Phase 1 — Venue intelligence injection

**Files:** `apps/worker/src/hybrid-agent-prompt.ts`, `apps/worker/src/hybrid-agent-evaluator.ts`

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
| Instrument ID | Funding Rate | 24h Change | 24h Volume | Open Interest |
|---------------|-------------|------------|------------|---------------|
| LIT-PERP      | 0.001%      | +12.3%     | $45.2M     | 2.1M          |
```

**Table key is `instrumentId`** — the same identifier the agent sees in every
other table and must return in its JSON response. This eliminates ambiguity:
the agent copies the value from any table column 1 directly into
`"instrumentId"` in its response.

**Mapping logic at prompt-build time:** `RuntimeVenueSignal.instrument` stores
the base symbol (e.g. `"BTC"`), not the `instrumentId` (e.g. `"BTC-PERP"`).
The `pricingIdentities` sidecar on `TechnicalScanState` provides the reverse
mapping (`instrumentId → { symbol, chain, kind }`) needed to match venue
signals to instrumentIds:

```typescript
function resolveVenueSignalForInstrument(
  instrumentId: string,
  pricingIdentities: Record<string, HybridPricingIdentity> | undefined,
  venueSignals: RuntimeVenueSignal[],
): RuntimeVenueSignal | undefined {
  const pricingId = pricingIdentities?.[instrumentId];
  if (!pricingId) return undefined;
  return venueSignals.find(
    (vs) => vs.instrument.toUpperCase() === pricingId.symbol.toUpperCase(),
  );
}
```

Filtering rules:
- Only include instruments that appear in the signal table OR the open positions table.
- For each instrumentId, resolve its venue signal via `pricingIdentities`.
- If unmatched, show `—` in all columns (instrument still listed — agent knows it exists).
- If venue intelligence is stale, show values with staleness marker (e.g. `0.010% (stale 8m)`).
- If no venue intelligence is available for any relevant instrument, omit the section entirely.

In `apps/worker/src/hybrid-agent-evaluator.ts`, pass `state.metrics.venueSignals`
and `scan.pricingIdentities` into the prompt input:

```typescript
const promptInput: HybridPromptInput = {
  // ... existing fields ...
  venueSignals: state.metrics.venueSignals,
};
// scan.pricingIdentities is already available via input.scan
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

When the agent has trading capability (`hasTradingCapability` is true), replace:

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

For non-trading agents, keep the existing text unchanged. Gate on the same
`hasTradingCapability` check already used for venue line rendering in
`buildScoutSystemPrompt`.

This enumerates *data events* the scout can observe, not *thresholds* it must
evaluate. The scout's `readOnlyTools` already give it access to check these.

## Implementation Phases

| Phase | Description | Files | Effort |
|---|---|---|---|
| 1 | Venue intelligence injection with `instrumentId` key via `pricingIdentities` | `hybrid-agent-prompt.ts`, `hybrid-agent-evaluator.ts` | Small |
| 2 | Richer exit review (P&L, hold duration, current price) | `hybrid-agent-prompt.ts` | Small |
| 3 | Scanner rejection landscape from `symbolOutcomes` | `hybrid-agent-prompt.ts` | Trivial |
| 4 | Optional `reason` field in schema + prompt example | `agent-protocol.ts`, `hybrid-agent-prompt.ts` | Trivial |
| 5 | Scout escalation enumeration (trading agents only) | `scout-dispatch.ts` | Trivial |

All phases are independent and can be implemented in any order. Phase 1 is the
only phase that requires plumbing a new field through the evaluator → prompt
builder boundary; the rest are local changes to existing rendering or schema.

## Test Plan

- **Phase 1:** Extend `hybrid-agent-evaluator.test.ts` — verify venue intelligence
  renders in prompt when `venueSignals` is passed with matching
  `pricingIdentities`; verify `instrumentId` is used as the table key (not base
  symbol); verify `—` fallback for unmatched instruments; verify staleness
  markers render; verify section is omitted when no relevant instruments match.
- **Phase 2:** Extend existing exit review tests — verify P&L, hold duration, and
  current price columns render when open position data is available; verify `—`
  fallback when not matched.
- **Phase 3:** Unit test `buildHybridPrompt` with `symbolOutcomes` containing
  various `CandleFetchStatus` values — verify breakdown renders; verify fallback
  to bare summary when `symbolOutcomes` is empty.
- **Phase 4:** Add schema parse test for `reason` field (present, absent, empty
  string). Verify the field does NOT appear in `agent.decision.submit` payloads.
- **Phase 5:** Unit test `buildScoutSystemPrompt` — verify escalation enumeration
  renders when trading capability is present; verify existing vague text is kept
  when trading capability is absent.
