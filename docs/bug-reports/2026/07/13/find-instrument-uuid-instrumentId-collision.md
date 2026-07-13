# Bug Report: `find_instrument` Returns DB UUID as `instrumentId`, Causing `submit_decision` Rejection

**Date:** 2026-07-13  
**Severity:** HIGH  
**Status:** Open  
**Discovered By:** Agent evaluation (`evaluate-agent` skill)  
**Affected Agents:** `tintelligence` (37019c92-be78-44a1-a942-d5025374f004)  
**Environment:** Hetzner staging (`128.140.55.192`)

---

## Summary

When an agent calls `find_instrument` to resolve a symbol (e.g. "ZEC"), the tool returns the **database UUID** as the `instrumentId` field. The LLM agent naturally passes this UUID to `submit_decision` (which also has a parameter called `instrumentId`), but `submit_decision` expects a **venue symbol** (e.g. "ZEC"). The intake resolver rejects the UUID as `instrument_unknown`.

This is a **naming collision** between two different meanings of `instrumentId`:
- `find_instrument` → `instrumentId` = internal database primary key (UUID)
- `submit_decision` → `instrumentId` = venue-recognized symbol (e.g. "ZEC", "SOL/USDC")

---

## Root Cause

### Direct cause

In `apps/worker/src/tools/find-instrument.ts`, line ~66:

```typescript
instruments: results.map((r) => ({
  instrumentId: r.id,       // ← DB UUID (e.g. "63982074-a987-44a7-b943-6de1bb54ff6f")
  symbol: r.symbol,          // ← Venue symbol (e.g. "ZEC/USDC:USDC")
  base: r.base,              // ← Base ticker (e.g. "ZEC")
  ...
}))
```

The field `instrumentId` is populated with `r.id`, which is the internal database primary key. The LLM agent reads the field literally named `instrumentId` and passes it to the `submit_decision` tool, which also has a parameter named `instrumentId` — but expects a venue symbol.

### Contributing factors

1. **Identical parameter names across tools with different semantics:**
   - `find_instrument` response field: `instrumentId` = DB UUID
   - `submit_decision` parameter: `instrumentId` = venue symbol
   - The LLM has no way to distinguish these — they look like the same concept.

2. **`submit_decision` prompt guidance is correct but insufficient:**
   The tool's `promptGuidance` says: *"Call find_instrument to get the correct instrumentId"*. The LLM followed this instruction literally — it got `instrumentId` from `find_instrument` and used it. The guidance needs to be explicit about which field to use.

3. **`find_instrument` does not expose a field that directly maps to `submit_decision`'s `instrumentId`:**
   For Hyperliquid perps, `submit_decision` expects the base ticker (e.g. "ZEC"). `find_instrument` returns this as `base`, but the field name `base` is less obvious to the LLM than `instrumentId`.

---

## Evidence

### Agent message trace (from production)

**find_instrument call:**
```json
{
  "toolName": "find_instrument",
  "args": { "query": "ZEC", "venue": "hyperliquid" }
}
```

**find_instrument result:**
```json
{
  "status": "ok",
  "data": {
    "ok": true,
    "query": "ZEC",
    "count": 2,
    "instruments": [
      {
        "instrumentId": "63982074-a987-44a7-b943-6de1bb54ff6f",  // ← DB UUID
        "symbol": "ZEC/USDC:USDC",
        "base": "ZEC",
        "quote": "USDC",
        "type": "perp",
        "venue": "hyperliquid",
        "tickSize": "0.01",
        "lotSize": "0.01"
      }
    ]
  }
}
```

**submit_decision call (first attempt — uses UUID):**
```json
{
  "toolName": "submit_decision",
  "args": {
    "instrumentId": "63982074-a987-44a7-b943-6de1bb54ff6f",  // ← DB UUID from find_instrument
    "intent": "go_long",
    "targetSize": "0.47",
    ...
  }
}
```

**Decision failure recorded:**
```
Failure ID:  b4200081-b3d4-4d0c-9111-148e31c6fcac
Code:        instrument_unknown
Class:       rejection
Message:     '63982074-a987-44a7-b943-6de1bb54ff6f' is not a recognized instrument on hyperliquid
```

**submit_decision call (second attempt — retries with "ZEC"):**
```json
{
  "toolName": "submit_decision",
  "args": {
    "instrumentId": "ZEC",  // ← Agent fell back to bare symbol
    ...
  }
}
```
This second attempt also failed with `no_context` because the agent is in shadow mode.

### Code trace

1. `find-instrument.ts:66` — `instrumentId: r.id` maps DB PK UUID to the response field named `instrumentId`
2. `trading.ts:9` — `SubmitDecisionParamsSchema.instrumentId` is described as "Venue-specific instrument identifier"
3. `agent-intake-resolver.ts:85` — `instrumentCache.hasSymbol(binding.venue, instrumentId)` checks the UUID against venue symbols → `instrument_unknown`

---

## Impact

- **Agents cannot trade** when they follow the documented workflow (find_instrument → submit_decision).
- The first submission ALWAYS fails because the LLM naturally uses the field called `instrumentId` from the search results.
- Agents may retry with a bare symbol (as tintelligence did), but by then they've wasted an LLM turn and the decision may still fail for other reasons (e.g. shadow mode, no context).
- This is a **systemic bug** — it affects every agent that calls `find_instrument` before `submit_decision`.

---

## Recommended Fix

### Option A: Rename the DB UUID field in `find_instrument` response (Preferred)

In `apps/worker/src/tools/find-instrument.ts`, change the response field mapping:

```typescript
// BEFORE (broken):
instruments: results.map((r) => ({
  instrumentId: r.id,     // DB UUID — ambiguous
  symbol: r.symbol,
  base: r.base,
  ...
}))

// AFTER (fixed):
instruments: results.map((r) => ({
  id: r.id,                // DB internal ID — clearly not a venue symbol
  instrumentId: r.base,    // Base ticker = what submit_decision expects for perps
  symbol: r.symbol,        // Full pair symbol (e.g. "ZEC/USDC:USDC")
  base: r.base,
  ...
}))
```

**Rationale:** The field named `instrumentId` should hold the value that `submit_decision` expects. For perps venues, this is the base ticker. For swap venues, this would be the pair symbol (e.g. "SOL/USDC"). The DB UUID can remain available under a clearly distinct name like `id` or `dbId`.

**Trade-off:** This changes the response shape, which could affect agents that have learned the old format. However, since the old format is broken (agents using it get rejected), this is a strict improvement.

### Option B: Make `submit_decision` accept DB UUIDs

Modify the intake resolver to resolve DB UUIDs to venue symbols before validation. This would require joining the `instruments` table during decision intake.

**Trade-off:** Adds DB dependency to the hot path. More complex. Doesn't address the semantic confusion for the LLM.

### Option C: Better prompt guidance only

Update the `find_instrument` description and `submit_decision` prompt guidance to explicitly say: *"Use the `base` field (not `instrumentId`) as the instrumentId for submit_decision."*

**Trade-off:** Relies on the LLM reading and following nuanced instructions. Brittle. The field naming is fundamentally misleading.

---

## Related

- **Agent evaluation report:** `.ignore/eval/2026/07/13/37019c92-be78-44a1-a942-d5025374f004/01/REPORT.md` §3.1.A
- **Decision failure record:** `decision_failures` row `b4200081-b3d4-4d0c-9111-148e31c6fcac`
- **Tool implementation:** `apps/worker/src/tools/find-instrument.ts`
- **Intake resolver:** `apps/worker/src/agents/agent-intake-resolver.ts:85` (`hasSymbol` check)

---

## Appendix: Full Agent Decision Trace

```
Tick 1 (judge phase, deepseek-v4-pro):
  03:06:21  find_instrument("ZEC", venue="hyperliquid")
  03:06:55  ← result: [{ instrumentId: "63982074-...", symbol: "ZEC/USDC:USDC", base: "ZEC" }]
  03:07:09  submit_decision(instrumentId="63982074-...")  ← USES UUID → REJECTED
  03:07:09  ← error: "'63982074-...' is not a recognized instrument on hyperliquid"
  03:07:17  submit_decision(instrumentId="ZEC")            ← RETRIES WITH SYMBOL → REJECTED
  03:07:17  ← error: "No decision context available"
```
