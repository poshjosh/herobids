# Bug Report: Agent Swap Assets Crash — Stale Dist

- **Status:** FIXED
- **Severity:** Critical
- **Date:** 2026-06-16
- **Summary:** 1inch agents crash on startup with `Swap venue 1inch requires explicit swapAssets metadata` because the compiled dist was stale — the source had already been fixed but the Docker image wasn't rebuilt.

## Root Cause

The source code in `apps/worker/src/agent-trading-actor.ts` had been updated to allow agents to start without `swapAssets` (logging a warning instead of throwing). However, the compiled output at `apps/worker/dist/agent-trading-actor.js` still contained the old `throw` statement:

```js
// dist/agent-trading-actor.js (STALE)
if (!deps.swapAssets) {
    throw new Error(`Swap venue ${deps.venue} requires explicit swapAssets metadata for agent ${deps.agentId}`);
}
```

The Docker worker image was built before the source fix was applied, so the running container executed the stale throw. The source fix was present on disk but never compiled into the running image.

## Error Log

```
Error: Swap venue 1inch requires explicit swapAssets metadata for agent b1aa0f48-b49e-4bed-a8d3-e38c466372cc
    at AgentTradingActor.start (/app/apps/worker/src/agent-trading-actor.ts:269:17)
```

## Fix

1. Rebuilt TypeScript: `pnpm --filter @herobids/worker run build`
2. Rebuilt Docker image: `docker compose build worker`
3. Restarted worker container: `docker compose up -d worker`

No source code changes were needed — the source already had the correct fix:
- `apps/worker/src/agent-trading-actor.ts` — Warns instead of throwing when `swapAssets` is absent
- `apps/worker/src/index.ts` — No longer throws for missing `swapAssets` on agent startup

## Files Changed

| File | Change |
|------|--------|
| `apps/worker/dist/agent-trading-actor.js` | Rebuilt from fixed source — throw removed |
| `apps/worker/dist/index.js` | Rebuilt from fixed source |

## Verification

Ran `scripts/shell/tests/agent-trade-test.sh` with VENUE=1inch, EXECUTION_MODE=shadow:

```
PASS — agent opened and closed a position — full trade cycle confirmed.
```

Agent flow: created → started → active → opened WETH position → closed position → stopped → deleted. All assertions passed including journal events, position visibility, and bookkeeping audit.

## Related

- `docs/bug-reports/2026/06/16/001-agent-swap-assets-resolution/001-plan.md` — Design plan for the swap assets resolution feature
