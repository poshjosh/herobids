# Move Venue from Technical Config to Trading Setup

## Summary

The `venue` field currently lives in `TechnicalConfig.filters.venue` (the Strategy section). The system actually has **three** places where venue surfaces: (1) Platform link, (2) Trading setup venue, (3) Strategy/technical-config venue. All three should collapse into one: **the Platform link ("Where to trade") derives the other two.**

## Three Venue Concepts → One Source of Truth

| # | Current label | Location | Purpose |
|---|---|---|---|
| 1 | "Platform link" | Trading setup (Advanced → AI Config tab) | Which provider connection to use |
| 2 | (implicit, missing) | Trading setup | What venue to execute on |
| 3 | "Venue" | Strategy tab (TechnicalConfigSection) | Which exchange to scan for instruments |

All three answer the same question: **where does this agent trade?** The answer lives in the connection's `provider` field. Selecting "My HL Account" (Hyperliquid) means:

```
connection.provider = 'hyperliquid'
  → venue = 'hyperliquid'
  → venueType = 'orderbook'
```

These are injected into `technicalConfig.filters` automatically. The user answers once.

## Problem

### What's Broken

A user creating a paper-trading agent with the Trading skill preset and a goal gets blocked with **"Venue is required for technical trading"** when trying to submit the form for review. The user never filled in a venue — and shouldn't have to for paper trading — but the validator rejects the submission.

### Root Cause

Three things combine to produce this:

1. **Auto-derivation forces `both` mode.** `deriveCapabilityMode()` sets `capabilityMode` to `'both'` whenever the user picks a trading skill AND writes a goal. This is unconditional — it doesn't consider execution mode.

   ```ts
   // derive-capability-mode.ts
   if (hasTradingSkill && hasIntelligence) return 'both';
   ```

2. **`both` mode activates the technical config path.** `showTechnical = true` causes the validator to check `venue` in `technicalConfig.filters.venue`.

   ```ts
   // form-validation.ts
   if (showTechnical && !intent.venue.trim()) {
     errors.venue = 'Venue is required for technical trading.';
   }
   ```

3. **`venue` is buried in the Strategy section** (inside `TechnicalConfigSection`, under the strategy tab), not in Trading Setup where the user naturally looks. The user skips it.

### Deeper Issue: Two Separate Venue Concepts

The system actually has **two distinct venue concepts** that serve different purposes but share the same name:

| Concept | Location | Purpose |
|---|---|---|
| **Execution venue** | Trading connection/binding | *Where orders are sent* — derived from the provider link (Hyperliquid, Jupiter, etc.) |
| **Discovery venue** | `technicalConfig.filters.venue` | *Which exchange to scan for candidate instruments* — used by the technical scanner's `discoverCandidates()` |

For live/shadow trading, these are the same venue (you trade on Hyperliquid, you scan Hyperliquid). For paper trading, neither is strictly needed — there is no real execution, and the scout can default to any available venue.

Keeping them separate forces the user to configure the same information twice in two different places, and the duplicate validation gate blocks paper trading where neither should be mandatory.

### Impact

- **Paper trading agents are blocked** from being created with the Trading preset + a goal
- **All trading agents** with `both` capability mode must fill in a venue field that conceptually belongs elsewhere
- The form's section labels ("Strategy" for the technical config, "Trading Setup" for connections) create a mental model mismatch — venue feels like infrastructure, not strategy

## Desired End State

### Goal

The user should configure venue **once**, in Trading Setup, and the technical scanner should derive its discovery venue from there automatically.

### Target UX (Simplified)

```
Trading Setup section:
  ┌─────────────────────────────────────┐
  │ Where to trade  [My HL Account ▼]   │  ← RENAMED from "Platform link"
  │                                      │  ← venue + venueType derived from this
  │ Execution mode   [Paper ▼]          │
  │ Capital          [1000]             │
  │ ...                                  │
  └─────────────────────────────────────┘

Strategy section (TechnicalConfig):
  ┌─────────────────────────────────────┐
  │ Preset   [Momentum Breakout ▼]      │
  │ Signal bias  [Trend-following ▼]    │
  │ Indicators ...                       │
  │ Candles ...                          │
  │ Scan interval ...                    │
  │ (venue removed — injected from above)│
  └─────────────────────────────────────┘
```

### Rules

| Connection exists? | Execution mode | Venue behavior |
|---|---|---|
| Yes | any | Derived from selected connection's `provider`. Shown as read-only. |
| No | `paper` | Dropdown with hardcoded venues (hyperliquid, jupiter). Optional. |
| No | `live` / `shadow` | Dropdown with hardcoded venues. **Required** — error if empty on submit. |

### Validation

- `Venue is required` only when execution mode is `live` or `shadow` AND no venue is set
- For paper mode, venue is always optional — the scout can run without it
- `technicalConfig.filters.venue` is populated automatically from the derived venue — user never fills it directly

## Proposed Approach (Phase 1 — Frontend Only)

1. **Rename "Platform link" → "Where to trade"** — this one field is the single source of truth
2. **Derive venue/venueType from the selected connection:** when the user picks a binding, `venue = binding.provider`, `venueType` from a fixed mapping (`hyperliquid` → `orderbook`, `jupiter` → `swap`). Show as read-only below the selector
3. **No connection (paper mode):** show a venue dropdown with hardcoded options (hyperliquid, jupiter). Same mapping for venueType
4. **Remove the venue dropdown from `TechnicalConfigSection`** — the Strategy tab no longer asks for venue
5. **Update `form-validation.ts`:** remove the `showTechnical` venue check; add venue check gated on `executionMode !== 'paper'`
6. **Inject venue/venueType into `technicalConfig.filters`** before calling `technicalFormStateToPayload()`, so the API payload still satisfies the backend schema
7. **Apply same derivation in `EditAgentModal`** for consistency
8. **Keep `deriveCapabilityMode` unchanged** — `both` mode is still correct; the fix is that venue no longer blocks it

### What This Doesn't Do (Yet)

- Does not change the backend domain schema (`TechnicalConfig.filters.venue` still exists)
- Does not unify the venue concepts at the worker/scout level
- Does not handle stale venue after connection changes post-creation

## Open Questions

1. What if the user has multiple connections? Proposal: the first selected connection's provider becomes the venue. If the user switches connections, venue updates accordingly.
2. Should changing the connection after agent creation update the technical config venue? Proposal: not in Phase 1 — accept the initial snapshot.
3. The `venueType` mapping is hardcoded today. If new providers (bybit, 1inch) are added, the mapping needs updating. Proposal: add them to the mapping now for forward compatibility.
