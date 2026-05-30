# Bug Report: Wrong Hyperliquid Symbol Format Prevents All Trading

- **Status:** FIXED
- **Severity:** Critical
- **Date:** 2026-05-30
- **Summary:** The rollout script defaulted to `ETH/USD:USD` as the trading symbol, but Hyperliquid's CCXT integration uses `ETH/USDC:USDC` for perpetual contracts. Every `fetchTicker` call threw "hyperliquid does not have market symbol ETH/USD:USD", which was caught by the adapter's `withRateLimit` wrapper and returned as an error Result. `fetchPrice()` then returned `null`, causing `tick()` to exit silently every cycle. The instance appeared healthy (reconciliation passed, no errors logged) but could never generate orders.

## Root Cause

The rollout script's default symbol variable was set to `ETH/USD:USD`:

```bash
SYMBOL="${ROLLOUT_SYMBOL:-ETH/USD:USD}"
```

Hyperliquid's CCXT markets use USDC as the quote and settlement currency:
- Spot: `ETH/USDC`
- Perpetual: `ETH/USDC:USDC`

The symbol `ETH/USD:USD` matches no market on the exchange.

## Symptoms

- Instance status: `running` (appeared healthy)
- Reconciliation: passing every 30s (fetches positions by account, not by symbol)
- Orders: 0, fills: 0, indefinitely
- No errors or warnings in worker logs
- Strategy never evaluated (never received a price snapshot)

## Diagnosis Path

1. Observed orders=0 after 3+ minutes (well past 100s warmup)
2. No tick/decision/error messages in worker log — only reconciliation passes
3. Identified that `fetchPrice()` returns null when `fetchTicker` fails
4. Tested CCXT directly: `exchange.fetchTicker('ETH/USD:USD')` → throws
5. Loaded markets: only `ETH/USDC:USDC` exists for ETH perps

## Fix

**`scripts/shell/rollout-stage-b.sh`** — Changed default symbol to match Hyperliquid's actual CCXT market identifier:

```bash
SYMBOL="${ROLLOUT_SYMBOL:-ETH/USDC:USDC}"
```

## Lesson

- Always validate venue symbols against the exchange's actual market list before hardcoding
- The CCXT symbol format varies by exchange (some use USD, others USDT, others USDC)
- Silent failures in the tick loop are extremely dangerous — see bug 006
