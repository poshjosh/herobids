# Implementation Plan: Phase 5 — LLM Enrichment

When an agent has both `technical` and `intelligence` configured, inject
structured indicator data into the LLM's context so it reasons over pre-computed
technical analysis rather than raw prices.

**Files:**
- `apps/worker/src/runtime-composition.ts` — add technical context block
- `apps/worker/src/agent-trading-actor.ts` — wire technical results into LLM wake

**Depends on:** Phase 3 (technical phase produces results)

---

## Design

### Data Flow

```
Technical phase (every scanInterval):
  → produces ScoredSignal[] + RegimeResult
  → stores in agent-local state: lastTechnicalScan

Intelligence phase (every wakeInterval):
  → reads lastTechnicalScan
  → runtime-composition injects it as structured context block
  → LLM sees: "## Technical Analysis\n| Symbol | Confidence | RSI | MACD | ... |"
  → LLM makes final decision with full context
```

### Context Block Format

Injected into the agent's user context (runtime-composition):

```markdown
## Technical Scan Results
Last scan: 2026-06-16T10:30:00Z | Regime: PASS (ADX 32, bullish alignment)

### Top Signals (ranked by confidence)
| Symbol | Confidence | RSI | MACD | Volume | CHOCH | Reasons |
|--------|-----------|-----|------|--------|-------|---------|
| ETH-PERP | 0.72 | 55 | +bullish crossover | 2.1x | — | RSI healthy, MACD crossover, volume strong |
| SOL-PERP | 0.58 | 48 | +increasing | 1.6x | bullish | RSI healthy, MACD positive, CHOCH up |
| BTC-PERP | 0.41 | 62 | +increasing | 1.2x | — | RSI healthy, MACD positive |

### Open Positions (indicator update)
| Symbol | Side | Entry | Current | P&L | RSI | Signal |
|--------|------|-------|---------|-----|-----|--------|
| ARB-PERP | long | $1.20 | $1.35 | +12.5% | 71 | Weakening (approaching overbought) |

### Rejected (did not pass filters)
15 instruments scanned, 12 rejected (RSI overbought: 3, MACD negative: 5, low volume: 4)
```

### How It Helps the LLM

Without enrichment (current):
- LLM sees positions + raw prices + maybe some metadata
- Must reason from scratch about entry/exit decisions
- May miss technical signals or make inconsistent calls

With enrichment:
- LLM sees pre-ranked candidates with indicator scores
- Can focus on higher-level reasoning: correlations, macro, risk allocation
- Fewer tokens needed (structured data vs raw analysis)
- More consistent decisions (indicators are deterministic input)

---

## Checklist

### Agent State

- [ ] Add `lastTechnicalScan` field to agent actor state:
  ```typescript
  lastTechnicalScan?: {
    timestamp: string;
    regimeResult: RegimeResult | null;
    signals: ScoredSignal[];
    positionIndicators: PositionIndicatorUpdate[];
    summary: { scanned: number; rejected: number; passed: number };
  }
  ```
- [ ] Technical phase writes to this after each scan
- [ ] Intelligence phase reads it when composing context

### Runtime Composition

- [ ] Add new context block builder in `runtime-composition.ts`:
  `buildTechnicalContextBlock(lastTechnicalScan)`
- [ ] Register block with appropriate priority (after positions, before market data)
- [ ] Block is only included when `lastTechnicalScan` is non-null and fresh
  (within 2× scanInterval — skip stale data)
- [ ] Format as markdown table for LLM readability
- [ ] Include regime status summary
- [ ] Include rejection summary (helps LLM understand market breadth)

### Token Budget

- [ ] Technical context block has a configurable max size
- [ ] If too many signals, truncate to top N by confidence
- [ ] Position indicators always included (small, high value)
- [ ] Regime summary always included (1 line)

### Tests

- [ ] Context block renders correctly from sample scan results
- [ ] Stale scan data (old timestamp) is excluded
- [ ] Token budget truncation works (top N signals only)
- [ ] Empty scan results → no block (or minimal "no signals" note)
- [ ] Block format is parseable by LLM (verify with snapshot test)
- [ ] Intelligence-only agent (no technical) → no block added

---

## Definition of Done

- [ ] Agent with both `technical` + `intelligence` produces enriched LLM context
- [ ] LLM sees structured indicator table in its wake context
- [ ] Technical data freshness enforced (stale data excluded)
- [ ] No behavioral change for intelligence-only agents
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes
