# Crypto Ecosystem

The crypto ecosystem is made up of layers — blockchains, exchanges, and aggregators — each doing a different job. Understanding these layers helps you pick the right venues for your agents to trade on.

## Two worlds: CeFi and DeFi

Crypto finance runs in two parallel systems:

- **Centralized finance (CeFi)** — Companies own the trading infrastructure. You create an account, they hold your funds, and you trade on their platform.
- **Decentralized finance (DeFi)** — Smart contracts on blockchains provide the infrastructure. You keep custody of your funds in your own wallet.

Most traders use both.

## The layers

```
                         CRYPTO ECOSYSTEM

                    ┌────────────────────────┐
                    │      BLOCKCHAINS       │
                    │  Ethereum, Solana      │
                    │  Base, Arbitrum, etc.  │
                    └───────────┬────────────┘
                                │
               ┌────────────────┴────────────────┐
               │                                 │
         CENTRALIZED (CeFi)                 DECENTRALIZED (DeFi)
               │                                 │
         ┌─────┴─────┐                   ┌───────┴────────┐
         │           │                   │                │
      Spot CEX    Perps CEX          Spot DEX       Perps DEX
         │           │                   │                │
      Bybit      Bybit Futures      Uniswap        Hyperliquid
      Binance    Binance Futures    Raydium
      Coinbase                     PancakeSwap
                                          │
                                          │
                              ┌───────────┴───────────┐
                              │    DEX Aggregators    │
                              │                       │
                       1inch (EVM chains)     Jupiter (Solana)
```

### Blockchain

The network where everything runs. Think of it as the roads — applications are built on top. Examples: Base, Ethereum, Solana.

### Centralized Exchange (CEX)

A company-run trading platform. You create an account, deposit funds, and trade on their orderbook. Most require identity verification (KYC). Example: Bybit.

### Decentralized Exchange (DEX)

A smart-contract-based exchange on a blockchain. No account needed — you trade directly from your wallet. Example: Uniswap.

### Perpetual Futures (Perps)

Not a venue type, but a **trading product**. Perps let you trade with leverage (2x, 5x, 10x or more), go long or short, and hold positions indefinitely with no expiry. Available on both CEXs (Bybit Futures) and DEXs (Hyperliquid).

### DEX Aggregator

A service that scans multiple DEXs to find the best price for your trade, then routes your order there automatically. Think Google Maps for exchanges. Examples: 1inch (EVM chains), Jupiter (Solana).

## Where OpenAIdom fits

OpenAIdom connects your agents to venues across these layers:

| Venue | Category | What you can do |
|---|---|---|
| [Hyperliquid](/docs/trading-venues/hyperliquid) | Perpetual DEX | Leveraged long/short trades |
| [Bybit](/docs/trading-venues/bybit) | Centralized Exchange (CEX) | Spot and futures trading |
| [Jupiter](/docs/trading-venues/jupiter) | DEX Aggregator (Solana) | Token swaps at best prices |
| [1inch](/docs/trading-venues/1inch) | DEX Aggregator (EVM) | Multi-chain token swaps |

## Key insight

These aren't competing products — they're different layers:

- **Base** provides the **roads** (the blockchain).
- **DEXs** are the **shops** on those roads.
- **1inch** and **Jupiter** are **Google Maps** for those shops — they find the best route.
- **Bybit** is a **private shopping mall** with its own internal infrastructure (a centralized exchange).
- **Hyperliquid** is a specialized decentralized marketplace for **perpetual futures**.

The only direct overlaps:
- **Bybit** and **Hyperliquid** both offer perpetual futures, but one is centralized and the other decentralized.
- **1inch** and **Jupiter** are both DEX aggregators, but 1inch serves EVM chains (Ethereum, Base, Arbitrum…) while Jupiter serves Solana.

## Learn more

- [Crypto Ecosystem: Aspects](/docs/reference/crypto-ecosystem-aspects) — A deeper breakdown of each category with analogies.
- [Trading Venues](/docs/trading-venues) — OpenAIdom's supported venues and when to use each.
- [Glossary](/docs/reference/glossary) — Definitions of terms used across the platform.
