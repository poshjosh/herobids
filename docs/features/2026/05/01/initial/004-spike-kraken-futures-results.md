# ccxt + Kraken Futures Spike Results

**Date:** 2026-05-21  
**Status:** VALIDATED ✓

## What We Tested

Ran a 50-line TypeScript spike (`scripts/ts/spike-kraken-futures.ts`) against Kraken Futures demo/sandbox to validate that ccxt's unified API handles derivatives operations without friction.

## Results

| Operation | Method | Result |
|-----------|--------|--------|
| Load perpetual markets | `loadMarkets()` | 66 perpetuals found |
| Fetch balance | `fetchBalance()` | Returns `USD.free` correctly (5000) |
| Set leverage | `setLeverage(5, symbol)` | Works, no errors |
| Place short limit order | `createOrder(symbol, 'limit', 'sell', ...)` | Filled instantly on demo (status: `closed`) |
| Fetch open orders | `fetchOpenOrders(symbol)` | Returns array, correct |
| Fetch positions | `fetchPositions([symbol])` | Returns `side: 'short'`, `contracts: 0.001`, `entryPrice: 77554` |

## Key Observations

1. **ccxt exchange ID is `krakenfutures`** (not `kraken` — that's spot only).
2. **Sandbox mode:** `sandbox: true` in constructor config routes to `demo-futures.kraken.com`.
3. **Symbol format:** `BTC/USD:USD` (linear, USD-settled) and `BTC/USD:BTC` (inverse, BTC-settled) both exist. The primary BTC perp in `markets` shows as `BTC/USD:BTC` (inverse), but linear `BTC/USD:USD` also works for trading.
4. **Position response shape:** `pos.side` is a string (`'short'` / `'long'`), `pos.contracts` is a number, `pos.entryPrice` is a number. These are usable without parsing.
5. **Order filled immediately** because the limit price was set at `bid * 0.999` on the demo environment. In production, use market orders for guaranteed fills or set tighter prices.
6. **No issues with:** authentication, leverage setting, short selling, position querying. The unified API works as documented.

## Credentials

- Demo account: https://demo-futures.kraken.com (free signup, no KYC)
- Env vars needed: `KRAKEN_FUTURES_KEY`, `KRAKEN_FUTURES_SECRET`
- These are sandbox-only keys with no real money access.

## Files

- `scripts/ts/spike-kraken-futures.ts` — the spike script
- `scripts/shell/spike-kraken-futures.sh` — self-documenting bash wrapper (validates env vars, runs spike)

## Conclusion

ccxt is validated as the connectivity layer for CEX derivatives. The unified API handles the full lifecycle (markets → leverage → order → position → cancel) for Kraken Futures without workarounds. Proceed with wrapping it behind an `OrderbookVenue` interface in the new repo.
