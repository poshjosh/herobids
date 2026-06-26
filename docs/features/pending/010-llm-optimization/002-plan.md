# LLM Optimization — Implementation Plan (Items 1–5)

Source: [001-llm-optimization-gap.md](./001-llm-optimization-gap.md)  
Reference impl: [000-aitrading-bots-llm-optimization.md](./000-aitrading-bots-llm-optimization.md)

---

## Overview

Five targeted changes to reduce LLM input/output token waste. Items 4 and 5 are
schema/parse-layer hardening with no runtime dependencies. Item 1 is a
formatting utility with pure functions. Items 2 and 3 are bundled: they both
require the same memory context provider and config knobs.

Estimated effort per phase: 1 is small, 4 is small, 5 is small, 2+3 is medium.

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

## Phase 2 — Memory Context Provider + Entry Truncation (Items 2 & 3)

**Gap items:** #2 (entry truncation) and #3 (older keys-only display)  
**Impact:** Caps the memory section of the system prompt even as agents accumulate
many entries. Prevents unbounded prompt growth from active memory use.

### Problem

Agent memories live in Redis at `agent:memory:${agentId}` (a hash map). They are
currently never displayed in the system prompt — agents retrieve them on-demand
with `get_memory`. As agents start using memory heavily, there's value in showing
recent entries directly in the system prompt (reducing `get_memory` round-trips and
cost) — but only if the display is bounded.

Items 2 and 3 are inseparable: showing entries in the prompt without truncation
would worsen token cost, not improve it.

### Config knobs

Add to `packages/domain/src/config/schema.ts` inside `defaultBudgets`:

```typescript
maxContextMemories:     z.number().int().min(0).default(15),
maxMemoryEntryChars:    z.number().int().min(0).default(1000),
maxContextOlderKeys:    z.number().int().min(0).default(30),
```

Add to `config/default.yaml` under `defaultBudgets`:

```yaml
maxContextMemories: 15       # full-content entries in system prompt
maxMemoryEntryChars: 1000    # chars per entry before "... [read_memory for full]" marker
maxContextOlderKeys: 30      # keys-only lines beyond maxContextMemories
```

### Data flow

`RuntimeSessionMetrics` needs to carry the preloaded memory snapshot so that the
sync context provider can read it.

**`apps/worker/src/runtime-composition.ts` — `RuntimeSessionMetrics` interface**

Add a field:

```typescript
agentMemories: Record<string, string> | null;
```

Initialise to `null` in `createRuntimeCompositionState`.

**`apps/worker/src/agent.ts` — tick loop, before `composeSystemPrompt`**

Load memories from Redis once per tick (before building the prompt):

```typescript
const rawMemories = await redis.hgetall(`agent:memory:${AGENT_ID}`);
runtimeState.metrics.agentMemories = rawMemories ?? null;
```

This is a single `HGETALL` per tick — cheap for typical memory sizes (<50 keys).

### Memory context provider

Add to `RUNTIME_CONTEXT_PROVIDERS` in `runtime-composition.ts`, section `'static'`,
`costTier: 'cheap'`, `trimOrder: 7` (trimmable, low priority):

```typescript
{
  id: 'agent-memory',
  costTier: 'cheap',
  section: 'static',
  requiredFamilies: [],
  trimOrder: 7,
  build: (state) => {
    const memories = state.metrics.agentMemories;
    if (!memories || Object.keys(memories).length === 0) return null;

    const budgets = state.runtimeDescriptor.budgets;
    const maxFull    = budgets.maxContextMemories   ?? 15;
    const maxChars   = budgets.maxMemoryEntryChars  ?? 1000;
    const maxOldKeys = budgets.maxContextOlderKeys  ?? 30;

    const keys = Object.keys(memories).sort(); // deterministic alphabetical order
    const fullKeys  = keys.slice(0, maxFull);
    const olderKeys = keys.slice(maxFull, maxFull + maxOldKeys);
    const hiddenCount = Math.max(0, keys.length - maxFull - maxOldKeys);

    const lines: string[] = [];

    // Full-content entries
    for (const key of fullKeys) {
      const raw = memories[key] ?? '';
      // Redis stores JSON-stringified values; display the raw string
      const content = raw.length > maxChars
        ? `${raw.slice(0, maxChars)}... [read_memory for full]`
        : raw;
      lines.push(`${key}: ${content}`);
    }

    // Keys-only entries
    if (olderKeys.length > 0) {
      lines.push('');
      lines.push('Older keys (no content — use get_memory to read):');
      lines.push(olderKeys.join(', '));
    }

    if (hiddenCount > 0) {
      lines.push(`(+${hiddenCount} more — use list_memory_keys tool)`);
    }

    return {
      id: 'agentMemory',
      title: 'Memory',
      provider: 'agent-memory',
      content: lines.join('\n'),
    };
  },
},
```

### Skill instruction hint

Add a line to the base memory skill instructions (wherever skill seed text lives —
search for the `set_memory` / `get_memory` skill definition):

> "Memory entries over ~1,000 characters are truncated in your context display.
> Keep entries concise — headline + key data points."

### Tests

Add unit tests to `apps/worker/src/runtime-composition.test.ts` (or a new
`agent-memory-provider.test.ts`):

- No-op when `agentMemories` is null or `{}`.
- Full content shown for ≤ `maxContextMemories` entries.
- Content truncated with marker when entry exceeds `maxMemoryEntryChars`.
- Entries beyond `maxContextMemories` appear as keys-only.
- Entries beyond `maxContextMemories + maxContextOlderKeys` appear as `(+N more)`.
- Keys are displayed in alphabetical order (deterministic).

---

## Phase 3 — Output `maxLength` Constraints on Reason Fields (Item 4)

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

## Phase 4 — `stripEmptyValues()` on LLM Output (Item 5)

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

| Phase | Items | Effort | Dependencies |
|-------|-------|--------|--------------|
| 3 — `maxLength` schema constraints | #4 | Small | None |
| 4 — `stripEmptyValues` utility | #5 | Small | None |
| 1 — `fmtNum` formatting | #1 | Small | None |
| 2 — Memory context provider | #2 + #3 | Medium | Config schema changes |

Phases 1, 3, and 4 are independent. Do them in any order or in parallel. Phase 2
builds on the config schema changes and the memory-loading step in agent.ts — do it
last or in its own PR.

---

## Checklist

- [ ] `apps/worker/src/fmt.ts` — `fmtNum`, `fmtUsd`
- [ ] `apps/worker/src/fmt.test.ts` — unit tests
- [ ] `apps/worker/src/runtime-composition.ts` — apply `fmtUsd`/`fmtNum` to discovery trigger, venue intelligence, `formatCurrency`
- [ ] `apps/worker/src/hybrid-agent-prompt.ts` — apply `fmtUsd` to capital/PnL lines
- [ ] `packages/domain/src/config/schema.ts` — add `maxContextMemories`, `maxMemoryEntryChars`, `maxContextOlderKeys` to `defaultBudgets`
- [ ] `config/default.yaml` — add defaults for the three new knobs
- [ ] `apps/worker/src/runtime-composition.ts` — add `agentMemories` to `RuntimeSessionMetrics`, init to `null`, add `agent-memory` context provider
- [ ] `apps/worker/src/agent.ts` — `HGETALL` before `composeSystemPrompt`, store in `runtimeState.metrics.agentMemories`
- [ ] Skill instruction hint about memory truncation
- [ ] Memory provider unit tests
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
