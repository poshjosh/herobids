# Bug Report 003 — Market-data discovery provider rejections (geckoterminal 429 / coinmarketcap 403)

- **Status:** CLOSED — NOT migration-caused (pre-existing upstream config; not fixed)
- **Severity:** Low
- **Date:** 2026-09-23
- **Environment:** development; local docker compose cross-stack

## Summary

The traderton boundary log is dominated by repeating discovery-provider
rejections:
- `geckoterminal/... : 429 Too Many Requests` (every discovery cycle)
- `coinmarketcap/... : 403 Forbidden` (credential/plan issue, not rate-limit)

These surface in the boundary/worker logs because the discovery coordinator
moved Traderton-side (slice B6). The rejections are continuous rather than
transient.

## Migration causation assessment — **NOT caused by the migration**

The `@traderton/market-data` package was copied from herobids **verbatim, zero
seams** (`git log` — "Phase 4: extract @traderton/market-data — copy
packages/market-data verbatim"). URL/key-selection logic is unchanged:

1. **geckoterminal 429** — traderton `.env` has `COINGECKO_API_KEY=` **empty**,
   so `config.apiKey` is falsy → free tier `api.geckoterminal.com` →
   free-tier rate-limit exhaustion. `buildGeckoUrl`/`buildGeckoHeaders` are
   byte-identical to pre-migration herobids (`55c53756^`).
2. **coinmarketcap 403** — key is present, but the endpoint is
   `pro-api.coinmarketcap.com` (default unchanged); a 403 is an upstream
   auth/plan rejection (free-tier key against the pro endpoint, or invalid/expired
   key), independent of which process hosts the coordinator.

The migration only moved *where* these rejections appear in logs (boundary log
vs herobids worker log); it did not change the provider config, credentials, or
the rejection causes.

## Outcome

Stopped per instruction ("if not caused by migration — stop"). No code fix.
Operational follow-ups (owner dispatch only, no code):
- Fix/replace the CoinMarketCap credential (403 = auth failure).
- Either add a valid GeckoTerminal Pro key or reduce discovery cadence to fit the
  free tier.

## Related

- traderton `packages/market-data/src/{geckoterminal,coinmarketcap}.ts` (verbatim copy)
- traderton `.env` (`COINGECKO_API_KEY` empty)
- traderton `packages/domain/src/config/schema.ts:256` (`pro-api.coinmarketcap.com` default)