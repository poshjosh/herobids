# Bug Report: Bot Restart Hangs on Swap Venues

**Bug ID:** 001-bot-restart-hangs-on-swap-venues
**Severity:** High
**Date:** 2026-07-27
**Status:** Open

## Summary

After a bot on a swap venue (1inch) is stopped and then restarted, it never transitions from `starting` to `running`. The initial start works, stop works, but the restart hangs indefinitely. The bot-trade-test polls for `status === 'running'` and times out.

## Symptoms

```
16:45:01.495  ✓ Bot status → stopped
16:45:01.506  ✓ Restart accepted: starting
16:55:02.750  ✗ FATAL: Timeout waiting for: Bot status → running (after restart)
```

The bot stays in `starting` for the full timeout (10 minutes). No crash or error is reported — the worker simply never completes the restart.

## Hypothesis

The swap-venue DMA/shadow-polling stream or mark-price subscription is not fully released on stop, blocking re-initialization on restart. Unlike orderbook venues (Hyperliquid) where WebSocket streams are managed by the public stream pool with ref-counting, swap venues may hold exclusive resources that aren't properly cleaned up.

## Affected Code

- `apps/worker/src/runtime.ts` — `startInstance()` / `stopInstance()` lifecycle
- Venue-specific DMA or shadow-polling setup in the swap venue adapter
- Bot lifecycle manager queue processing

## Mitigation

The `bot-trade-test.ts` restart phase (3h–3j) and idempotency checks (4a–4b) are skipped for swap venues with a warning. See the TODO in that file referencing this bug report.

## Verification

1. Run `bot-trade-test.sh` with `VENUE=1inch` — restart phase is skipped with warning
2. Run `bot-trade-test.sh` with `VENUE=hyperliquid` — restart phase runs normally
3. Once fixed, remove the skip guard from `bot-trade-test.ts`
