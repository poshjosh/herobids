# BUG-001: Hyperliquid Public Stream Symbol Format Mismatch

**Status:** CLOSED

**Severity:** High

**Date:** 2026-05-24

## Summary

The `HyperliquidPublicStream` connector uses raw Hyperliquid coin names (`BTC`, `ETH`) in its WebSocket protocol, but the rest of the system passes unified CCXT symbols (`BTC/USD:USD`, `ETH/USDC`). This causes the stream to never match incoming WS events against subscribed symbols, resulting in shadow mode actors receiving no market data.

## Root Cause

- `sendSubscriptions()` sent the unified symbol directly as the `coin` field in WS subscribe messages
- `handleTrades()`, `handleOrderbook()`, `handleAllMids()` compared the raw `coin` from WS payloads against the unified symbol set — never matching
- Events were emitted with raw coin names instead of unified symbols, so downstream consumers (StreamMarketDataFeed) couldn't match them to their requested symbols

## Fix

Added `toRawCoin()` helper that extracts the base asset from a unified symbol (e.g. `BTC/USD:USD` → `BTC`). The connector now:
1. Tracks a `coinToSymbols` map (raw coin → Set of unified symbols)
2. Subscribes on the wire using raw coin names
3. Filters incoming events by raw coin name
4. Emits events tagged with the original unified symbol(s)

## Files Changed

- `packages/venues/src/hyperliquid-public-stream.ts`

## Regression Test

- `packages/venues/src/hyperliquid-public-stream.test.ts` — tests symbol normalization round-trip
