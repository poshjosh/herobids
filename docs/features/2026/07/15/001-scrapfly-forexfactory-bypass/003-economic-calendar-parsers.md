# Plan: Structured Economic Calendar Parsers (DOM + LLM + Fallback)

**Status:** Implemented ✅ — verified locally (worker log: "Economic calendar initial cache warmed", eventCount: 2, DOM parser path)
**Date:** 2026-07-15
**Depends on:** `002-background-economic-calendar-refresh.md`

---

## Problem

The economic calendar HTML parser has two weaknesses:

1. **The LLM parser uses a fragile regex** to extract the calendar `<table>` from
   raw HTML. If Forex Factory changes its class names or markup structure, the
   regex silently fails and falls back to sending the full 472KB page to the LLM
   — expensive and slow.

2. **No non-LLM option exists.** On local dev with Ollama, the LLM path can
   time out (>60s for 150KB HTML on a local model). In production the LLM works,
   but costs ~$0.03/refresh. A DOM-based parser would be instant and free.

## Solution

Three parsers implementing the same signature (`(html: string) => Promise<EconomicEvent[]>`),
with the combined fallback parser as the default:

```
EconomicCalendarParserFn = (html: string) => Promise<EconomicEvent[]>

  ├── createDomCalendarParser()        node-html-parser, ~10ms, free
  ├── createLlmCalendarParser(config)  LLM-based, ~5–60s, costs tokens
  │     └── uses node-html-parser to extract <table> (replaces regex)
  └── createFallbackCalendarParser()   tries Dom → on failure → Llm
```

The fallback parser is the **default** at all call sites. The operator can swap
parsers independently by changing what's injected as `parseHtmlFn`.

### Why `node-html-parser`

- ~500KB (vs cheerio's ~5MB), zero dependencies
- jQuery-like `querySelector` / `querySelectorAll` API
- Handles malformed HTML gracefully (unlike regex)
- Already chosen over cheerio for this specific use case

### Naming

| Factory | Return type | What it does |
|---------|-------------|--------------|
| `createDomCalendarParser()` | `EconomicCalendarParserFn` | DOM parsing via `node-html-parser` |
| `createLlmCalendarParser(config)` | `EconomicCalendarParserFn` | LLM extraction (exists, refactored) |
| `createFallbackCalendarParser(config)` | `EconomicCalendarParserFn` | DOM → LLM fallback |

All three live in `packages/market-data/src/economic-calendar.ts` and are
exported from `packages/market-data/src/index.ts`.

### Type alias

Introduce a named type in `economic-calendar.ts`:

```typescript
export type EconomicCalendarParserFn = (html: string) => Promise<EconomicEvent[]>;
```

Replace the inline `(html: string) => Promise<EconomicEvent[]>` in
`ForexFactoryAdapterConfig.parseHtmlFn`.

## Design

### `createDomCalendarParser()`

Pure DOM extraction — no LLM, no network, no cost.

```typescript
import { parse, type HTMLElement } from 'node-html-parser';

export function createDomCalendarParser(): EconomicCalendarParserFn {
  return async (html: string): Promise<EconomicEvent[]> => {
    const root = parse(html);
    const table = root.querySelector('table.calendar');
    if (!table) throw new Error('Calendar table not found');

    const events: EconomicEvent[] = [];
    const rows = table.querySelectorAll('tr.calendar__row');

    for (const row of rows) {
      // Skip day-breaker rows
      if (row.classList.contains('calendar__row--day-breaker')) continue;

      const cells = row.querySelectorAll('td');
      if (cells.length < 3) continue;

      const time = cells[0]?.textContent?.trim() ?? '';
      const currency = cells[1]?.textContent?.trim() ?? '';
      const event = cells[2]?.textContent?.trim() ?? '';

      // Impact is inferred from class on row or icon element
      const impact = resolveImpact(row);

      // Forecast and previous are optional (columns 3-4 if present)
      const forecast = cells[3]?.textContent?.trim() || null;
      const previous = cells[4]?.textContent?.trim() || null;

      if (!event || !time) continue;

      events.push({
        time: normalizeTime(time),
        currency: currency.toUpperCase().slice(0, 3),
        event,
        impact,
        forecast: forecast || null,
        previous: previous || null,
        sources: ['forex-factory'],
      });
    }

    return events;
  };
}
```

The key method is `resolveImpact(row: HTMLElement)` which checks for known
impact classes (`calendar__impact--high`, `--medium`, `--low`) on the row or its
child elements. This is the only part that would need updating if FF changes its
CSS.

**Failure modes:**
- Table not found → throw → triggers fallback parser
- No rows match → return empty array (valid — could be a quiet day)

### `createLlmCalendarParser(config)` — refactored

Replace the regex table extraction with `node-html-parser`:

```typescript
// Before (regex):
const tableMatch = html.match(/<table[^>]*class="calendar"[^>]*>([\s\S]*?)<\/table>/i);
const tableHtml = tableMatch?.[1] ?? html;

// After (DOM):
const root = parse(html);
const table = root.querySelector('table.calendar');
const tableHtml = table?.outerHTML ?? html;
```

The rest of the function (LLM call, JSON parsing, validation) stays unchanged.
This is a strict improvement — the DOM selector handles nested tables, malformed
markup, and class variants that the regex would miss.

### `createFallbackCalendarParser(config)`

```typescript
export function createFallbackCalendarParser(
  llmConfig: LlmCalendarParserConfig,
): EconomicCalendarParserFn {
  const domParser = createDomCalendarParser();
  const llmParser = createLlmCalendarParser(llmConfig);

  return async (html: string): Promise<EconomicEvent[]> => {
    try {
      return await domParser(html);
    } catch (domError) {
      // DOM parser failed (table not found, structure changed) — fall back to LLM
      try {
        return await llmParser(html);
      } catch (llmError) {
        throw new Error(
          `Calendar parse failed: DOM (${(domError as Error).message}), LLM (${(llmError as Error).message})`,
        );
      }
    }
  };
}
```

When the DOM parser succeeds (the common case), the LLM is never called — zero
cost, sub-10ms. When the DOM parser fails (FF changed its markup), the LLM
handles it gracefully. Only when both fail do we surface an error.

### Call site changes

| File | Current | Change |
|------|---------|--------|
| `apps/worker/src/index.ts` (background refresh) | `createLlmCalendarParser({...})` | `createFallbackCalendarParser({...})` |
| `apps/worker/src/agent.ts` | No parseHtmlFn (agent uses `cacheOnly`) | No change needed |

The agent container no longer injects `parseHtmlFn` since it operates in
`cacheOnly` mode. Only the worker background refresh needs the parser.

### Dependency

Add `node-html-parser` to `packages/market-data/package.json`:

```bash
pnpm --filter @herobids/market-data add node-html-parser
```

### Export changes (`packages/market-data/src/index.ts`)

Add:
```typescript
export {
  createDomCalendarParser,
  createFallbackCalendarParser,
  type EconomicCalendarParserFn,
} from './economic-calendar.js';
```

`createLlmCalendarParser` and `LlmCalendarParserConfig` are already exported.

### Remove

- The regex `tableMatch`/`tableHtml` extraction inside `createLlmCalendarParser`
  (replaced by `node-html-parser` selector).
- The `console.warn` in `CompositeEconomicCalendarProvider` on stale cache
  (pre-existing — not related to this plan, just noting it).

## Implementation Steps

1. **[DONE] Add dependency:** `pnpm --filter @herobids/market-data add node-html-parser`.
2. **[DONE] Add type alias:** `EconomicCalendarParserFn` in `economic-calendar.ts`; update `ForexFactoryAdapterConfig.parseHtmlFn` to use it.
3. **[DONE] Implement `createDomCalendarParser()`** with `node-html-parser` table extraction, row iteration, impact resolution.
4. **[DONE] Refactor `createLlmCalendarParser()`** — replace regex table extraction with `node-html-parser` selector.
5. **[DONE] Implement `createFallbackCalendarParser(config)`** — DOM → LLM fallback.
6. **[DONE] Update worker background refresh** in `apps/worker/src/index.ts` to use `createFallbackCalendarParser` instead of `createLlmCalendarParser`.
7. **[DONE] Export** new factories and type from `packages/market-data/src/index.ts`.
8. **[DONE] Tests:** market-data 315 passed, worker 1986 passed, lint clean, build clean.
9. **[DONE] Local verification:** worker log confirms "Economic calendar initial cache warmed" with eventCount: 2, DOM parser path (no LLM call).
10. **[DONE] Changelog:** add entry.

## Testing Plan

- **Unit: `createDomCalendarParser()`** — parse a saved Forex Factory HTML fixture, verify event count, verify impact detection, verify day-breakers are skipped, verify missing table throws.
- **Unit: `createLlmCalendarParser()`** — existing tests should pass with updated table extraction (mock the LLM fetch, verify the DOM selector produces the same or better table HTML than the regex).
- **Unit: `createFallbackCalendarParser()`** — DOM success (LLM never called), DOM failure → LLM called, both fail → error propagated.
- **Integration:** run `npx tsx scripts/ts/test-forexfactory-parser.ts --scrapfly` locally to exercise the full Scrapfly → DOM parse pipeline.
- **Existing tests:** all should continue to pass.

## Non-Goals

- Removing the LLM parser entirely (it's the fallback).
- Config-driven parser selection at the operator level (just inject the parser you want).
- Replacing `parseHtmlFn` with an enum or discriminated union — the function injection pattern is clean and flexible.

## Open Risks

- **Forex Factory impact class names may differ** from the assumed
  `calendar__impact--high`/`--medium`/`--low`. Mitigated by inspecting actual FF
  HTML during implementation and writing tests against saved fixtures.
- **`node-html-parser` performance on 472KB HTML** — ~10-50ms is expected for
  parse + single querySelector, but this should be measured.
