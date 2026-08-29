# Trading Domain Taxonomy

This document defines trading-owned language that should not be promoted into
the shared platform domain language unless a later cross-capability need proves
that it generalizes.

The shared platform vocabulary stops at:

1. capability
2. family
3. provider

Within that shared model, `trading` is the product capability. Everything below
that which is specific to markets, asset classes, execution styles, or venue
semantics belongs here in trading-owned documentation and contracts.

## Shared Boundary

At the shared platform layer, the trading capability may be represented as:

```text
trading
  swap
    jupiter
    1inch
  orderbook
    hyperliquid
    bybit
```

That is enough for shared concerns such as:

1. capability ownership
2. capability activation
3. tool ownership
4. service isolation
5. control-plane routing

## Trading-Owned Deeper Taxonomy

Trading may additionally define its own deeper taxonomy. A plausible current
shape is:

```text
markets
  crypto
  forex
  commodities

execution families
  swap
  orderbook
  cfd
  futures
  forwards
  options
```

The trading domain may choose different labels later. The shared platform does
not need to standardize them now.

## Terms

### Market

A trading-specific subdivision such as `crypto`, `forex`, or `commodities`.

`market` is a trading-domain term. It is not a shared platform primitive.

### Execution Family

A trading-specific family of execution or market interaction, such as `swap`,
`orderbook`, `cfd`, `futures`, `forwards`, or `options`.

Some execution families may be suitable for promotion into shared `family`
metadata when they matter to shared concerns. Others may remain internal to the
trading domain.

### Instrument Class

A trading-specific classification of tradable instruments. Examples may include
spot pairs, perpetuals, futures contracts, options, CFDs, or commodity
contracts.

This is not shared platform vocabulary by default.

### Venue Category

A trading-specific grouping of venues by execution semantics or market model.
Examples may include DEX aggregator, centralized orderbook venue, FX broker, or
futures broker.

This is not shared platform vocabulary by default.

## Ownership Rule

If a term is needed by messaging, documents, task management, marketplace, and
other future capabilities, it may belong in shared platform language.

If a term is needed only to explain trading, it belongs in trading-owned docs,
schemas, and APIs.

## Repository Boundary Rule

This document is compatible with a future separate trading repository.

If trading moves out of the main repo, the shared platform should still know
only:

1. the `trading` capability ID;
2. the shared capability-tool contract;
3. shared ownership and activation semantics; and
4. any shared control-plane metadata that the core platform must expose.

All richer market taxonomy can then move with the trading boundary.