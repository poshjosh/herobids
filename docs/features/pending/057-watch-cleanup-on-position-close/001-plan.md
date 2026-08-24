# Watch Cleanup on Position Close

**Created:** 2026-08-24  
**Status:** pending  
**Severity:** LOW  
**Depends on:** None

## Problem

When a position transitions to `flat` (closed), the system clears the in-memory `positions` and `exitLevels` maps and persists the flat state to the DB. However, any Redis watches that were linked to that position — including protective watches (`stop_loss`, `take_profit`, `exit`) with `coverage.positionKey` referencing the now-closed position — are left orphaned.

This is **not a safety gap**: per-trade stop-loss/take-profit enforcement is handled by the in-process `checkAllPerTradeLevels` periodic monitor (5s interval) reading from the `exitLevels` map, not from watches. The map is correctly cleared on position close.

The problem is purely operational:

1. **Context pollution** — The agent's watch summary (shown in prompt context on every tick) displays stale watch descriptions for closed positions. The LLM may reason incorrectly about its exposure.
2. **Wasted monitor cycles** — The market-intelligence monitor continues evaluating these watches every cycle, fetching prices for instruments the agent no longer holds.
3. **Spurious wake signals** — If a stale watch threshold fires, it delivers a wake/context event about a non-existent position, burning an LLM call on irrelevant information.
4. **Stale memory** — The agent may store position metadata via `set_memory` and never clean it up on close.

### Observed in Production

During the 2026-08-24 evaluation of agent `tintel` (ac3d53ec):
- 2 watches for the original SOL long position (take-profit $104.70, stop-loss $90.42) remained in Redis after the position was closed at 23:33 UTC.
- `lastCheckedAt` on both was `2026-08-23T20:44:23Z` — never evaluated again after creation.
- The agent's memory key `position_sol_long` still referenced the closed 8 SOL position while 2 new positions were active.
- New positions (ZEC 0.59, SOL 5.27) had no corresponding watches.

## Scope

This plan covers:
1. System-level cleanup of orphaned watches when a position closes
2. Prompting improvement to encourage the agent to clean memory on close

It does NOT cover:
- Watch creation for new positions (agent-initiated, correct by design)
- Memory garbage collection (remains agent-owned; system-level cleanup would violate agent mode purity)

## Design

### Approach: Cleanup via `positionKey` Matching in `persistPosition`

When `persistPosition` is called with `side === 'flat'`, scan the agent's watches hash for entries whose `coverage.positionKey` matches the closing position and remove them.

This is safe because:
- Protective watches (`stop_loss`, `take_profit`, `exit`) REQUIRE a valid `coverage.positionKey` at creation time (fail-closed enforcement in `watch_token`).
- Non-protective watches (`monitor`, `alert`) may or may not have coverage linkage. Those without `positionKey` are left untouched (they're informational, not position-bound).
- The `positionKey` format (`${venue}::${instrumentId ?? symbol}::${side}`) is deterministic and stable — the same position produces the same key everywhere.

### What Gets Removed

Only watches where ALL of these are true:
- `coverage.positionKey` exists
- `coverage.positionKey === derivePositionKey(closingPosition)`
- The watch `purpose` is a protective purpose (`stop_loss`, `take_profit`, `exit`)

Non-protective watches linked to the same position key (e.g. `monitor`, `alert`) are left intact — they represent informational subscriptions the agent may still care about.

### Edge Cases

| Case | Behaviour |
|------|-----------|
| Position closes but no watches have matching positionKey | No-op (no watches removed) |
| Multiple protective watches for same position | All removed |
| Watch has positionKey but non-protective purpose | Left intact |
| Watch has no coverage/positionKey | Left intact |
| Redis unavailable during cleanup | Log warning, do not fail the position close |
| Agent creates new watches after close | Normal flow — no conflict |

## Implementation

### Step 1: Add `removeProtectiveWatchesForPosition` helper

**File:** `apps/worker/src/tools/watch.ts` (or a new `apps/worker/src/watch-lifecycle.ts`)

```typescript
import { PROTECTIVE_WATCH_PURPOSES } from '../position-coverage.js';
import { parseWatch } from '../watch-types.js';

/**
 * Remove all protective watches linked to a specific positionKey.
 * Best-effort: logs and swallows errors (position close must not fail).
 */
export async function removeProtectiveWatchesForPosition(
  redis: Redis,
  agentId: string,
  positionKey: string,
  logger: Logger,
): Promise<number> {
  try {
    const raw = await redis.hgetall(`agent:watches:${agentId}`);
    if (!raw || Object.keys(raw).length === 0) return 0;

    const toRemove: string[] = [];
    for (const [watchId, value] of Object.entries(raw)) {
      const watch = parseWatch(value);
      if (!watch) continue;
      if (watch.coverage?.positionKey !== positionKey) continue;
      if (!watch.purpose || !(PROTECTIVE_WATCH_PURPOSES as readonly string[]).includes(watch.purpose)) continue;
      toRemove.push(watchId);
    }

    if (toRemove.length === 0) return 0;

    const pipeline = redis.pipeline();
    for (const watchId of toRemove) {
      pipeline.hdel(`agent:watches:${agentId}`, watchId);
    }
    await pipeline.exec();

    logger.info(
      { agentId, positionKey, removedCount: toRemove.length, watchIds: toRemove },
      'Removed orphaned protective watches for closed position',
    );

    // Refresh the summary cache so prompt context is immediately accurate.
    await refreshWatchSummaryAfterRemoval(redis, agentId);

    return toRemove.length;
  } catch (err) {
    logger.warn({ err, agentId, positionKey }, 'Failed to remove protective watches on position close — non-fatal');
    return 0;
  }
}
```

### Step 2: Call from `persistPosition` when position goes flat

In `AgentTradingActor.buildPersistence()`, inside the `persistPosition` callback, after the existing `side === 'flat'` cleanup:

```typescript
persistPosition: async (pos) => {
  // ... existing logic ...
  if (pos.side === 'flat') {
    this.positions.delete(pos.symbol);
    this.exitLevels.delete(pos.symbol);
    pendingExitLevels = null;

    // NEW: Remove orphaned protective watches for this closed position.
    const positionKey = derivePositionKey({
      venue: pos.venue,
      symbol: pos.symbol,
      side: /* the side BEFORE closing — need to derive from the pre-close state */,
      instrumentId: existingInstrumentId ?? undefined,
    });
    void removeProtectiveWatchesForPosition(
      this.deps.redis,
      this.agentId,
      positionKey,
      this.logger,
    );
  }
  // ... rest of existing logic ...
}
```

**Note on side derivation:** When the position goes flat, we need the side it was BEFORE closing (long or short) to compute the correct `positionKey`. This is available from `this.positions.get(pos.symbol)` before the `delete` — so the watch cleanup call must come BEFORE `this.positions.delete(pos.symbol)`, or the pre-close side must be captured earlier.

### Step 3: Same cleanup in `persistPrivateStreamPositionState`

The live-mode position reconciliation path (`persistPrivateStreamPositionState`) also sets positions to flat. Apply the same pattern:

```typescript
private async persistPrivateStreamPositionState(position: PositionState): Promise<void> {
  if (position.side === 'flat') {
    // Capture pre-close side before clearing the map
    const priorPosition = this.positions.get(position.symbol);
    if (priorPosition && priorPosition.side !== 'flat') {
      const positionKey = derivePositionKey({
        venue: position.venue,
        symbol: position.symbol,
        side: priorPosition.side,
        instrumentId: priorPosition.instrumentId ?? undefined,
      });
      void removeProtectiveWatchesForPosition(
        this.deps.redis,
        this.agentId,
        positionKey,
        this.logger,
      );
    }
    this.positions.delete(position.symbol);
    this.exitLevels.delete(position.symbol);
  }
  // ... rest ...
}
```

### Step 4: Refresh summary cache helper

Extract or reuse the summary refresh logic from `tools/watch.ts`:

```typescript
async function refreshWatchSummaryAfterRemoval(redis: Redis, agentId: string): Promise<void> {
  const raw = await redis.hgetall(`agent:watches:${agentId}`);
  const watches = Object.values(raw ?? {})
    .map(parseWatch)
    .filter((w): w is WatchEntry => w !== null)
    .map(toRuntimeActiveWatch);

  const summary = summarizeActiveWatches(watches);
  if (summary.totalCount === 0) {
    await redis.hdel(`agent:watches:summary:${agentId}`, 'summary');
  } else {
    await redis.hset(`agent:watches:summary:${agentId}`, 'summary', JSON.stringify(summary));
  }
}
```

### Step 5 (Optional): Prompt improvement for memory cleanup

Add a note in the trading skill's `go_flat` guidance (in the skill definition or prompt template) encouraging the agent to `delete_memory` for position-related keys after a successful close. This is soft guidance, not enforcement — memory remains agent-owned per agent mode purity.

Example addition to the skill prompt:
```
After a position is closed, clean up any position-specific memory keys 
(e.g. position_<symbol>_long) using delete_memory. Stale memory 
causes incorrect reasoning on subsequent ticks.
```

## Testing

1. **Unit test:** `removeProtectiveWatchesForPosition` correctly removes only protective watches matching the positionKey, leaves others intact.
2. **Integration test:** When a decision with `go_flat` completes and `persistPosition` fires with `side=flat`, verify:
   - Protective watches for that position are removed from Redis
   - Non-protective watches are untouched
   - Summary cache is refreshed
3. **Edge case:** Multiple positions for same symbol (shouldn't happen for same venue+side, but guard against it).
4. **Regression:** Existing watch_token / remove_watch / check_watches tools still work correctly.

## Dependencies

- `position-coverage.ts` — `derivePositionKey` (already exists)
- `watch-types.ts` — `parseWatch`, `WatchEntry` (already exists)
- `PROTECTIVE_WATCH_PURPOSES` constant (already exists)
- Redis access in `AgentTradingActor` — already available via `this.deps.redis`

## Risks

- **False removal:** If `positionKey` derivation differs between watch creation and position close, watches won't be matched. Mitigated by using the same `derivePositionKey` function in both paths.
- **Race condition:** Position closes while a new watch is being created for the same position. Mitigated by the watch creation's fail-closed enforcement: `watch_token` checks for an open position at creation time — if the position is already flat, the protective watch would be rejected.
- **Performance:** `hgetall` on the watches hash + parsing. Typically <10 watches per agent — negligible cost.
