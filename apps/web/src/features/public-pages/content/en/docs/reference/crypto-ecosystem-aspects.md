# Crypto Ecosystem: Aspects

A deeper breakdown of each layer in the crypto ecosystem. For a high-level overview, see [Crypto Ecosystem](/docs/reference/crypto-ecosystem).

---

## 1. Blockchain / Network

This is where transactions actually happen.

Think of a blockchain as the **country** where financial applications live. It executes smart contracts, stores assets, and processes transactions. Everything else is built on top.

Examples: Base, Ethereum, Solana, Arbitrum.

Without a blockchain, nothing else exists.

---

## 2. Centralized Exchanges (CEX)

Think of these as the **traditional stock exchanges** of crypto — run by companies.

Characteristics:

- The company controls custody of your funds (unless using special self-custody products)
- Order book matching engine for fast execution
- Login with email and password
- KYC (identity verification) usually required
- Trade spot and derivatives (futures, options)

Examples: Bybit, Binance, Coinbase, Kraken, OKX.

OpenAIdom supports **[Bybit](/docs/trading-venues/bybit)** for both spot and futures trading.

---

## 3. Decentralized Exchanges (DEX)

Instead of a company matching buyers and sellers, smart contracts perform the trades automatically on-chain.

Characteristics:

- You keep custody of your funds in your own wallet
- No account or KYC required
- Runs on a blockchain (on-chain)
- Usually for token swaps (spot trading)

Examples: Uniswap (Ethereum), Raydium (Solana), Orca (Solana), PancakeSwap (BNB Chain).

"DEX" is a **category**, not one specific platform. There are hundreds of DEXs across different blockchains.

---

## 4. Perpetual Futures (Perps)

"Perps" aren't a different technology — they're a different **type of trading product**.

Instead of buying an asset, you trade leveraged contracts that track its price. Key features:

- **Long or short** — Profit from prices going up or down
- **Leverage** — Trade with 2x, 5x, 10x, or more exposure
- **No expiry** — Hold positions indefinitely (unlike traditional futures)

Perps exist on both CEXs and DEXs:

| Type | Examples |
|---|---|
| CEX Perps | Bybit Futures, Binance Futures |
| DEX Perps | Hyperliquid, dYdX, GMX |

OpenAIdom supports **[Hyperliquid](/docs/trading-venues/hyperliquid)** for decentralized perpetual futures, and Bybit for centralized futures.

Hyperliquid is **not just a DEX** — it specializes in perpetual futures trading on its own high-performance chain.

---

## 5. DEX Aggregators

Aggregators don't execute trades themselves. Instead, they ask:

> "Which DEX currently offers the best price?"

Then they route your order there automatically.

Think of them like comparison sites:
- Google Flights → airlines
- Booking.com → hotels
- Jupiter → Solana DEXs
- 1inch → Ethereum / EVM DEXs

Examples:

| Aggregator | Ecosystem | OpenAIdom |
|---|---|---|
| [1inch](/docs/trading-venues/1inch) | EVM chains (Ethereum, Base, Arbitrum, etc.) | Supported |
| [Jupiter](/docs/trading-venues/jupiter) | Solana | Supported |

---

## One important distinction

Many people confuse **DEX** and **Aggregator**.

Imagine you want to buy a token:

- A **DEX** is like a single supermarket — you go there and buy at whatever price they offer.
- An **aggregator** drives around all the supermarkets, finds the cheapest price, and buys there for you automatically.

So:
- **Hyperliquid** is a venue where you trade perpetual futures.
- **Bybit** is a centralized exchange for spot and derivatives.
- **Jupiter** doesn't sell tokens — it finds the best Solana DEX to execute your swap.
- **1inch** does the same across Ethereum-compatible networks.
- **Base** is the blockchain those applications run on.

---

## See also

- [Crypto Ecosystem](/docs/reference/crypto-ecosystem) — High-level overview with the full picture.
- [Trading Venues](/docs/trading-venues) — OpenAIdom's supported venues and how to pick one.
- [Glossary](/docs/reference/glossary) — Platform terminology reference.
