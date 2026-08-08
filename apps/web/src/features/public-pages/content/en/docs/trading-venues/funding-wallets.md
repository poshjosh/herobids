# Funding Your Wallets

This guide covers how to fund wallets across all supported trading venues — both platform-generated wallets (created by OpenAIdom) and user-provided wallets connected via API keys or self-custodied wallets.

---

## Hyperliquid

### Platform-generated wallet (OpenAIdom creates it)

- **What to send:** USDC via Arbitrum bridge
- **Where to find the address:** Settings → Connections, or the wallet-created card in chat
- **Confirmation:** ~2–5 min after Arbitrum finality
- **Minimum recommended:** $50 USDC

### User-provided API keys

- Fund your Hyperliquid account via the standard Arbitrum bridge or exchange withdrawal
- See [Hyperliquid](/docs/trading-venues/hyperliquid) for connection setup

### Gas & fees

- Hyperliquid is gasless for spot USDC transfers
- Trading fees: maker/taker (see [hyperliquid.xyz](https://hyperliquid.xyz))

---

## Jupiter

### Platform-generated wallet (OpenAIdom creates it)

- **What to send:** SOL (for gas) + USDC (for trading)
- **Where to send from:** Any Solana wallet or exchange
- **Confirmation:** ~1–2 seconds (Solana)
- **Minimum recommended:** 0.05 SOL + $20 USDC

### User-provided wallet

- Ensure your connected Solana wallet holds SOL + USDC
- See [Jupiter](/docs/trading-venues/jupiter) for connection setup

### Gas & fees

- SOL for transaction fees (~0.000005 SOL per tx)
- Jupiter aggregates routes for best swap prices

---

## 1inch

### Platform-generated wallet (OpenAIdom creates it)

- **What to send:** ETH (for gas on Base) + USDC (for trading)
- **Where to bridge from:** Ethereum mainnet via Base Bridge, or send from exchange
- **Confirmation:** ~2–3 min (Base L2)
- **Minimum recommended:** 0.01 ETH + $20 USDC

### User-provided wallet

- Ensure your EVM wallet on Base holds ETH + USDC
- See [1inch](/docs/trading-venues/1inch) for connection setup

### Gas & fees

- ETH on Base for transaction fees
- 1inch aggregates across DEXs for best rates

---

## Bybit

- Bybit uses API keys only — no platform-generated wallets
- Fund your Bybit account via Bybit's standard deposit flow (USDT or USDC)
- See [Bybit](/docs/trading-venues/bybit) for connection setup
