# Bug Report: Worker Crash-Loop — Jupiter Token List Fetch Failure Kills Process

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-07-07
- **Summary:** `VenueInstrumentCache.warmup()` threw on Jupiter token list fetch failure (unreachable external endpoint) and propagated the error as an unhandled exception, crashing the worker process. Docker restarted it every ~60 s but it crashed again on every attempt, leaving agents permanently stuck in `starting`.

## Symptoms

- Worker container exits repeatedly with:
  ```
  Error: Failed to fetch Jupiter symbols: Failed to fetch Jupiter token list: fetch failed
      at Object.fetchSymbols (apps/worker/src/index.ts:940:29)
      at async VenueInstrumentCache.warmup (apps/worker/src/venue-instrument-cache.ts:40:25)
  ```
- `docker compose ps` shows worker `Restarting` every ~60 s.
- Any agent in `starting` state at the time of the crash stays stuck — no health monitor runs, no reconnect recovery, no status transition.
- Agent container is actually alive but the worker never connects back to it.

## Root Cause

`VenueInstrumentCache.warmup()` had a `throw err; // fail-closed` in its catch block. When Jupiter's external token list endpoint (`token.jup.ag`) was unreachable (e.g. no outbound internet in local Docker, or transient upstream failure), the thrown error propagated up through the `async` top-level `await instrumentCache.warmup(...)` call in `apps/worker/src/index.ts` and triggered `triggerUncaughtException`, crashing the Node.js process.

Because the worker crashed during startup — before `AgentHealthMonitor.start()` was ever called — the health monitor's stale-session recovery path (`handleStartTimeout`) never ran. Any agent whose session was in `starting` or `launching` at crash time was left indefinitely stuck.

The fail-closed design intent was to prevent trading on a venue with no symbol validation. However, `hasSymbol()` already returns `true` for venues not present in the cache (fail-open fallback), so the net effect of skipping a failed provider is degraded validation, not broken trading.

## Affected Files

- `apps/worker/src/venue-instrument-cache.ts` — warmup catch block

## Fix

Removed `throw err` from the warmup catch block. Failed providers are logged at `ERROR` level and skipped. `warmup()` always sets `ready = true` after iterating all providers, matching the behaviour of `startPeriodicRefresh` (which keeps stale cache and never throws on failure).

```ts
// Before
} catch (err) {
  this.logger.error({ err }, `VenueInstrumentCache: failed to fetch symbols for ${provider.venue}`);
  throw err; // fail-closed
}

// After
} catch (err) {
  this.logger.error(
    { err },
    `VenueInstrumentCache: failed to fetch symbols for ${provider.venue} — symbol validation disabled for this venue`,
  );
  // Skip this provider; hasSymbol() returns true for uncached venues (fail-open).
}
```

**Validation contract after the fix**: `hasSymbol()` already returns `true` for any venue not present in the cache (fail-open, by design). A provider that fails warmup simply leaves its venue uncached — identical to how 1inch is intentionally excluded from the cache. Healthy venues whose symbols loaded successfully are unaffected and continue to reject unknown instruments. The call sites in `agent-trading-actor.ts` and `agent-intake-resolver.ts` guard with `isReady() && !hasSymbol(venue, ...)`, so they behave correctly: validation fires for cached venues and passes through for uncached ones.

## Verification

After the fix, worker logs show:
```
ERROR  VenueInstrumentCache: failed to fetch symbols for jupiter — symbol validation disabled for this venue
INFO   VenueInstrumentCache: warmup complete, ready for validation
INFO   Agent trading actor started  mode=shadow venue=hyperliquid
INFO   Agent actor registered
INFO   Reconnect recovery complete
```

The previously-stuck agent (`6bad1d15-59c2-4e27-b60f-4c483a9d6d41`) transitioned from `starting` → `active` automatically once the worker started, as its container had survived the crash loop and the reconnect handler picked it up.
