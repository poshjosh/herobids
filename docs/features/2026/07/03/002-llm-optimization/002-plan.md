# LLM Optimization — Implementation Plan (Items 1, 4 & 5)

Source: [001-llm-optimization-gap.md](./001-llm-optimization-gap.md)  
Reference impl: [000-aitrading-bots-llm-optimization.md](./000-aitrading-bots-llm-optimization.md)

---

## Overview

Three targeted changes to reduce LLM input/output token waste. Items 4 and 5 are
schema/parse-layer hardening with no runtime dependencies. Item 1 is a
formatting utility with pure functions.

> **Items 2 & 3** (memory context provider + entry truncation) are **superseded by
> [020-prompt-context-enrichment/001-plan.md](../020-prompt-context-enrichment/001-plan.md)**,
> which implements a richer version with `promptStyle` gating, timestamp metadata,
> and hybrid evaluator support. Do not implement them here.

Estimated effort: Phase 1 is small, Phase 2 is small, Phase 3 is small. All three
are independent — do them in any order or in parallel.

---

## Phase 1 — Compact Number Formatting (`fmtNum`)

**Gap item:** #1  
**Impact:** ~30–40% reduction in market-data sections of every agent tick prompt.

### Problem

Large USD values are emitted as-is (`$4200000.00`, `$1234567.toLocaleString()` →
`$1,234,567`). Neither saves tokens. A `1.23M` / `12.3K` format reduces these
fields by 30–50% of their character length.

### Files to change

| File | Change |
|------|--------|
| `apps/worker/src/fmt.ts` | **New file.** `fmtNum(n)` and `fmtUsd(n)` utilities. |
| `apps/worker/src/runtime-composition.ts` | Replace `toLocaleString()` in discovery-trigger and venue-intelligence providers with `fmtNum`. Replace `formatCurrency` where large USD amounts appear. |
| `apps/worker/src/hybrid-agent-prompt.ts` | Apply `fmtUsd` to `availableCapitalUsd`, `unrealizedPnlUsd`, and the per-position cap suggestion. |

### Implementation detail

**`apps/worker/src/fmt.ts`**

```typescript
/**
 * Compact number formatter — reduces token cost of large numeric values.
 *   fmtNum(1_234_567)  →  "1.23M"
 *   fmtNum(12_345)     →  "12.3K"
 *   fmtNum(987)        →  "987"
 *   fmtNum(0.000123)   →  "0.000123"  (pass-through below 1 000)
 */
export function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000_000) return `${sign}${(abs / 1_000_000_000).toPrecision(3)}B`;
  if (abs >= 1_000_000)     return `${sign}${(abs / 1_000_000).toPrecision(3)}M`;
  if (abs >= 1_000)         return `${sign}${(abs / 1_000).toPrecision(3)}K`;
  return String(n);
}

export function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined) return 'unavailable';
  return `$${fmtNum(n)}`;
}
```

**`runtime-composition.ts` — discovery-trigger provider (lines ~748–764)**

Replace:
```typescript
const liquidity = ctx.liquidityUsd !== undefined ? `$${ctx.liquidityUsd.toLocaleString()}` : 'unavailable';
const volume    = ctx.volume24hUsd  !== undefined ? `$${ctx.volume24hUsd.toLocaleString()}`  : 'unavailable';
```
With:
```typescript
const liquidity = fmtUsd(ctx.liquidityUsd);
const volume    = fmtUsd(ctx.volume24hUsd);
```

**`runtime-composition.ts` — `formatCurrency` helper (line ~373)**

The existing `formatCurrency` emits `value.toFixed(2)` which produces 8+ chars for
large USD values (`$4200000.00`). Delegate to `fmtUsd` for non-trivial magnitudes:

```typescript
function formatCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'N/A';
  if (Math.abs(value) >= 10_000) return fmtUsd(value);
  return `$${value.toFixed(2)}`;
}
```

**`hybrid-agent-prompt.ts` — portfolio lines (~26, ~44, ~116)**

Replace raw `.toFixed(2)` USD calls with `fmtUsd`.

### Tests

Add `apps/worker/src/fmt.test.ts`:
- Verify `fmtNum` for representative values (B, M, K, sub-K, negative, zero, NaN).
- Verify `fmtUsd` for null/undefined passthrough.

---

## Phase 2 — Output `maxLength` Constraints on Reason Fields (Item 4)

**Gap item:** #4  
**Impact:** Caps output token waste from verbose agent rationale fields. A 1,000-char
rationale where 400 chars suffice wastes ~150 output tokens per decision.

### Changes

#### `packages/domain/src/agent-protocol.ts`

`DecisionSubmitPayloadSchema` — add `.max(400)` to `rationaleSummary`:

```typescript
rationaleSummary: z.string().min(1).max(400),
```

400 chars is enough for a meaningful one-paragraph rationale while eliminating
multi-paragraph dumps. The field is stored in the DB; keep it readable.

#### `packages/strategy/src/llm.ts`

`ParsedLlmDecision.reasoning` is only metadata. Constrain at the prompt level
rather than with a hard schema rejection (rejecting an otherwise valid decision
because the reasoning is too long would be a bad trade-off):

1. Update `buildPrompt` instruction line:
   ```
   - "reasoning": a brief explanation, max 80 characters
   ```
2. In `parseResponse`, silently truncate before returning:
   ```typescript
   reasoning: typeof parsed['reasoning'] === 'string'
     ? parsed['reasoning'].slice(0, 80)
     : undefined,
   ```

#### System prompt / skill instructions

If any skill instructions prompt the agent to submit a `rationaleSummary`, add:
> "Keep `rationaleSummary` under 400 characters."

### Tests

- Update any unit-test fixture that sets `rationaleSummary` to a string longer
  than 400 chars (search: `rationaleSummary.*`.length > 400) — change to fit.
- Assert that `DecisionSubmitPayloadSchema.safeParse` rejects a `rationaleSummary`
  of 401+ chars.
- Assert that `parseResponse` truncates `reasoning` to exactly 80 chars when the
  LLM returns a longer string.

---

## Phase 3 — `stripEmptyValues()` on LLM Output (Item 5)

**Gap item:** #5  
**Impact:** Prevents parse failures when an LLM emits `null` or `""` for optional
fields that have `min(1)` or other non-null constraints — turning hard parse errors
into graceful pass-throughs.

### New file: `packages/llm/src/strip.ts`

```typescript
/**
 * Remove keys whose value is null, undefined, or empty string from a flat
 * LLM output object before passing it to a Zod schema for validation.
 *
 * This handles the common LLM failure mode where optional fields are emitted
 * as null/""  instead of being omitted entirely.
 */
export function stripEmptyValues(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== undefined && v !== '') {
      out[k] = v;
    }
  }
  return out;
}
```

Export from `packages/llm/src/index.ts`.

### Apply in `packages/strategy/src/llm.ts` — `parseResponse`

After `JSON.parse`, before reading fields:

```typescript
const raw    = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
const parsed = stripEmptyValues(raw);
const intent = parsed['intent'] as string;
// ... existing validation continues unchanged
```

### Apply in `apps/worker/src/hybrid-agent-evaluator.ts`

The hybrid evaluator parses a JSON array. Apply `stripEmptyValues` to each element
before Zod validation:

```typescript
// Before: HybridAgentResponseSchema.safeParse(parsed)
// After:
const cleaned = Array.isArray(parsed)
  ? parsed.map((item) => (typeof item === 'object' && item !== null ? stripEmptyValues(item as Record<string, unknown>) : item))
  : parsed;
const result = HybridAgentResponseSchema.safeParse(cleaned);
```

### Tests

Add `packages/llm/src/strip.test.ts`:

```
stripEmptyValues({ a: 1, b: null, c: '' })       → { a: 1 }
stripEmptyValues({ a: 0, b: false, c: 'hello' }) → { a: 0, b: false, c: 'hello' }
stripEmptyValues({})                               → {}
```

Note: `0` and `false` are intentionally preserved — they are valid field values for
numeric and boolean fields.

---

## Execution order

| Phase | Item | Effort | Dependencies |
|-------|------|--------|--------------|
| 1 — `fmtNum` formatting | #1 | Small | None |
| 2 — `maxLength` schema constraints | #4 | Small | None |
| 3 — `stripEmptyValues` utility | #5 | Small | None |

All three phases are independent — do them in any order or in parallel.

---

## Checklist

- [ ] `apps/worker/src/fmt.ts` — `fmtNum`, `fmtUsd`
- [ ] `apps/worker/src/fmt.test.ts` — unit tests
- [ ] `apps/worker/src/runtime-composition.ts` — apply `fmtUsd`/`fmtNum` to discovery trigger, venue intelligence, `formatCurrency`
- [ ] `apps/worker/src/hybrid-agent-prompt.ts` — apply `fmtUsd` to capital/PnL lines
- [ ] `packages/domain/src/agent-protocol.ts` — `rationaleSummary: z.string().min(1).max(400)`
- [ ] `packages/strategy/src/llm.ts` — prompt instruction + 80-char truncation on `reasoning`
- [ ] Update tests that assert on `rationaleSummary` length
- [ ] `packages/llm/src/strip.ts` — `stripEmptyValues`
- [ ] Export from `packages/llm/src/index.ts`
- [ ] `packages/strategy/src/llm.ts` — apply `stripEmptyValues` in `parseResponse`
- [ ] `apps/worker/src/hybrid-agent-evaluator.ts` — apply `stripEmptyValues` per element
- [ ] `packages/llm/src/strip.test.ts` — unit tests
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

---

## Outstanding Issues

### [Phase 3 — stripEmptyValues Utility] (2026-07-03)

| # | Priority | File | Detail |
|---|----------|------|--------|
| 1 | MEDIUM | `packages/llm/src/strip.ts` | Whitespace-only strings (e.g. `"   "`, `"\t"`) are not stripped. LLM could emit whitespace-only values that survive the strip. Add `.trim()` check. |
| 2 | MEDIUM | `packages/llm/src/strip.test.ts` | Missing test case: all fields stripped → empty object `{}`. |
| 3 | LOW | `packages/llm/src/strip.ts` | JSDoc could clarify "flat only" more prominently — nested objects/arrays not recursed into. |
