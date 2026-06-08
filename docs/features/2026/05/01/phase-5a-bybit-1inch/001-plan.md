# Phase 5a: Bybit + 1inch Venue Adapters

## Objective

Add two new venue adapters to prove the port abstractions generalize:
- **Bybit** (orderbook) — validates `OrderbookVenuePort` beyond Hyperliquid
- **1inch on Base** (swap) — validates `SwapVenuePort` beyond Jupiter/Solana

## Implementation Order

Bybit first (same ccxt pattern, lower risk), then 1inch (new infra: viem, EVM signing).

---

## Part 1: Bybit (Orderbook)

### 1.1 Domain layer updates (`packages/domain/src/config/schema.ts`)
- Add `'bybit'` to `SUPPORTED_LIVE_VENUES`
- Add `'bybit'` to the `orderbookVenues` array in the venue/venueType refinement

### 1.2 Operator config (`config/default.yaml`)
- Add `venues.bybit` entry: `baseUrl`, `wsUrl`, `rateLimitPerSec`, `timeoutMs`

### 1.3 Adapter (`packages/venues/src/bybit.ts`)
- `BybitAdapter implements OrderbookVenuePort`
- ccxt `bybit` instance under the hood
- Detect account type (UTA vs Standard) at construction via `fetchBalance` response shape
- Map all 9 port methods: `submitOrder`, `cancelOrder`, `amendOrder`, `fetchPositions`, `fetchBalances`, `fetchTicker`, `fetchOpenOrders`, `fetchRecentFills`, `subscribePrivate`
- Rate limiter with per-category awareness (order: 10/s, position: 10/s, market: 120/5s) — use a conservative single bucket at 10/s for v1, document the per-category detail for future refinement

### 1.4 Private stream (`packages/venues/src/bybit-private-stream.ts`)
- `BybitPrivateStream implements Subscription`
- WebSocket auth: HMAC-SHA256 signature of `GET/realtime{expires}`
- Subscribe to topics: `order`, `execution`, `position`, `wallet`
- Normalize into `PrivateStreamHandlers` events (fills, order updates, position changes)
- Reconnection with exponential backoff + jitter (same contract as `HyperliquidPrivateStream`)
- Heartbeat: respond to ping frames, detect missed pongs for disconnect detection

### 1.5 Public stream (`packages/venues/src/bybit-public-stream.ts`)
- `BybitPublicStream implements VenueStreamConnector`
- Subscribe to `tickers.{symbol}`, `orderbook.{depth}.{symbol}`, `publicTrade.{symbol}`
- Normalize into `StreamTicker`, `StreamOrderbook`, `StreamTrade`
- Dynamic subscribe/unsubscribe as the stream pool adds/removes symbols

### 1.6 Credential validation (`apps/api/src/routes/credentials.ts`)
- Add `bybit` branch in `validateVenueSecrets`:
  - Require `apiKey` (non-empty string)
  - Require `secret` (non-empty string)
  - Optional `testnet` flag

### 1.7 Worker wiring (`apps/worker/`)
- Factory function to instantiate `BybitAdapter` from resolved credentials
- Register `BybitPublicStream` as a `VenueStreamConnector` in the stream pool
- Update credential-resolution logic to handle bybit credential shape

### 1.8 Export & index (`packages/venues/src/index.ts`)
- Export `BybitAdapter`, `BybitPrivateStream`, `BybitPublicStream` and their config types

### 1.9 Tests
- Unit: adapter method mapping (mock ccxt responses → port types)
- Unit: private stream auth signature generation
- Unit: public stream message normalization
- Integration: `bybit.integration.test.ts` (skipped in CI, run manually against testnet)
- API: credential validation — assert 400 on empty apiKey/secret

---

## Part 2: 1inch on Base (Swap) — Follow-up

### 2.1 New dependency
- Add `viem` to `packages/venues/package.json` (EVM signing, tx submission, contract reads)

### 2.2 Domain layer updates (`packages/domain/src/config/schema.ts`)
- Add `'1inch'` to the `swapVenues` array in the venue/venueType refinement

### 2.3 Operator config (`config/default.yaml`)
- Add `venues.1inch` entry: `baseUrl`, `chainId: 8453`, `rpcUrl`, `timeoutMs`

### 2.4 EVM signer (`packages/venues/src/evm-signer.ts`)
- Thin wrapper around viem's `WalletClient` + `publicClient`
- Accept private key from decrypted credential
- Sign transactions, submit to RPC, wait for tx receipt
- Shared by any future EVM venue (Uniswap, Paraswap, etc.)

### 2.5 Adapter (`packages/venues/src/oneinch-swap.ts`)
- `OneInchSwapAdapter implements SwapVenuePort`
- `quote()`: call 1inch Swap API `/quote` endpoint
- `executeSwap()`: call `/swap` to get tx data → sign with EVM signer → submit → wait for receipt
- `fetchBalances()`: multicall ERC-20 `balanceOf` via viem
- `fetchBalance(token)`: single ERC-20 balance check
- `fetchRecentTransactions(since)`: parse ERC-20 Transfer events from RPC logs

### 2.6 Token decimals
- On-chain fetch via ERC-20 `decimals()` call (cache indefinitely per token)
- Fail loudly if decimals() reverts (non-standard token)

### 2.7 Credential validation
- Add `'1inch'` branch in `validateVenueSecrets`:
  - Require `privateKey` (64 hex chars or 0x-prefixed 66 chars)
  - Require `apiKey` (1inch API key for rate-limit tier)

### 2.8 Tests
- Unit: quote response parsing, raw amount conversion, balance mapping
- Unit: EVM signer transaction signing (deterministic with known key)
- Integration: `oneinch.integration.test.ts` (skipped in CI)

---

## Caveats

### Bybit-specific

1. **Account type detection at runtime.** Bybit has Standard (separate spot/derivatives wallets) and Unified Trading Account (UTA, single margin pool). The adapter will detect which mode at construction time via the balance response shape. If Standard mode is detected, it routes position/balance calls to the derivatives sub-wallet. This adds branching complexity but covers all user accounts.

2. **Rate limits are endpoint-specific.** Unlike Hyperliquid's flat 10/s, Bybit has different limits per category (order: 10/s per symbol, market: 120/5s, etc.). v1 uses a single conservative bucket (10/s global). If this proves too restrictive under load, refine to per-category buckets later.

3. **Symbol format.** Bybit uses `BTCUSDT` for linear perpetuals (ccxt normalizes to `BTC/USDT:USDT`). The adapter must handle the ccxt-unified symbol format consistently with how instances are configured.

### 1inch-specific

4. **API key required.** 1inch v6 API requires a registered developer portal key. Free tier: ~1 req/s. The rate limiter needs strict defaults. The API key is a credential secret (stored encrypted alongside the wallet private key).

5. **Gas cost as a new dimension.** EVM swaps have significant gas costs (Base is low but non-trivial for small trades). The risk gate should eventually factor in estimated gas before approving a swap decision. For v1: log gas cost on each swap receipt but don't gate on it.

6. **Transaction confirmation model.** Unlike Jupiter (where `executeSwap` is quasi-synchronous), EVM swaps require: build tx → sign → broadcast → wait for inclusion → parse receipt. The adapter must handle reverts gracefully (return `err()`, not throw). Timeout on confirmation (configurable, default: 60s on Base).

7. **Chain ID is config, not code.** The adapter is parameterized by chain ID so the same `OneInchSwapAdapter` class works on Arbitrum, Ethereum, or Base without code changes. However, each chain needs its own venue config entry (different RPC URLs, gas characteristics). We'll register as `1inch` with `chainId: 8453` for now.

### Cross-cutting

8. **No strategy changes needed.** Strategies emit venue-agnostic `Decision` objects. The plan/routing layer selects the venue. Neither adapter requires strategy-layer changes.

9. **No schema migration needed.** The `credentials` and `venue_accounts` tables are venue-agnostic by design. New venues just store different secret shapes in the same encrypted JSONB column.

10. **Live rollout gating.** New venues start with `liveRollout.allowedVenues` excluding them. They must pass shadow verification before being added to the allowed list.
