# Bug Report 003 — Market-data discovery provider rejections (geckoterminal 429 / coinmarketcap 403)

- **Status:** OPEN
- **Severity:** Low
- **Date:** 2026-09-23
- **Environment:** development; local docker compose cross-stack

## Summary

The traderton boundary log is dominated by repeating discovery-provider
rejections:
- `geckoterminal/... : 429 Too Many Requests` (every discovery cycle)
- `coinmarketcap/... : 403 Forbidden` (credential/plan issue, not rate-limit)

These surface in the boundary/worker logs because the discovery coordinator (and
economic-calendar fetch) moved Traderton-side (slice B6). The rejections are
continuous rather than transient.

## Root Cause

Two distinct causes:
1. **geckoterminal 429** — the discovery budget (`market-data:budget:geckoterminal`
   Redis hash) is being exhausted every cycle; the coordinator's backoff is
   working (it rejects and retries) but the call volume/budget is tuned too
   aggressively for the free/basic GeckoTerminal tier.
2. **coinmarketcap 403** — misconfigured/missing/expired CoinMarketCap API
   credential; every call is denied regardless of budget.

Neither is a boundary correctness bug — the coordinator correctly *detects* and
*logs* the rejections. The issue is operational (creds/budget), and it only
became visible in these logs because of the migration moving the coordinator
behind the boundary.

## Fix (proposed / advise)

This is configuration, not code. Advise (do not act without operator greenlight):
- Verify the CoinMarketCap API key (403 = auth failure).
- Either raise the GeckoTerminal budget if on a paid tier, or reduce discovery
  call frequency / enabled vectors to fit the free tier.

## Files Changed

- None (config/credentials only; operator-owned).

## Verification

- After cred fix, boundary log no longer shows `coinmarketcap … 403`.
- `geckoterminal … 429` drops to transient/backoff-only if budget retuned.

## Related

- `traderton` market-data discovery coordinator (slice B6)
- Redis `market-data:budget:*` hashes