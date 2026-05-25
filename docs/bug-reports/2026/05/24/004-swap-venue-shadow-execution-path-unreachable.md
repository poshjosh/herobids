# BUG-004: Swap Venue Shadow Execution Path Unreachable

**Status:** CLOSED

**Severity:** High

**Date:** 2026-05-24

## Summary

Trading instances using swap venues (e.g. Jupiter) in `shadow` mode never created a `ShadowExecutor`. The shadow-execution code path was gated behind `deps.venuePort` which is only present for perp venues, making swap-based shadow testing impossible.

## Root Cause

In `apps/worker/src/trading-actor.ts`, the condition for creating a `ShadowExecutor` was:

```typescript
if (mode === 'shadow' && deps.venuePort) { ... }
```

Swap venues don't have a `venuePort` — they have a `swapVenue` — so the condition was always false for swap instances. The else-branch fell through to create a `PaperExecutor`, meaning swap shadow mode silently behaved like paper mode.

## Fix

Changed the condition to:

```typescript
if (mode === 'shadow' && (deps.venuePort || deps.swapVenue)) { ... }
```

This allows the shadow executor to be created for either venue type. The `MarketDataFeed` passed to `ShadowExecutor` is the same polling/stream feed already constructed earlier in the function.

## Files Changed

- `apps/worker/src/trading-actor.ts` (line ~124)

## Verification

- Unit tests in `trading-actor.test.ts` — 7 tests pass
- TypeScript compiles cleanly
