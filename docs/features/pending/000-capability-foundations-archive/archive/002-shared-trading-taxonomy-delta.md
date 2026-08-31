# Historical Shared Trading Taxonomy Delta

**Status:** superseded  
**Created:** 2026-08-29  
**Parent roadmap:** [Capability Implementation Roadmap](../001-roadmap.md)  
**Amends:** [ADR 002](../../../../tech/architecture/adrs/2026/07/002-capability-model-and-registry.md), [ADR 003](../../../../tech/architecture/adrs/2026/07/003-agent-core-vs-capability-services.md), [ADR 004](../../../../tech/architecture/adrs/2026/07/004-capability-registry-and-tool-exposure-model.md)

## Superseded Note

This draft has been superseded by direct edits to the stable shared-platform
docs and ADRs, plus the propagated pending capability-foundations documents.

It is retained only as a historical explanation of the taxonomy correction from
shared `crypto-trading` to shared `trading`.

## Purpose

Amend the current capability ADR direction so the shared platform vocabulary
stays generic while still allowing the trading domain to expand beyond crypto
into forex or commodities.

The key correction is simple:

1. the shared platform should model `trading` as the capability;
2. the shared platform should stop at `family`; and
3. deeper trading taxonomy such as `crypto`, `forex`, and `commodities`
   belongs to the trading boundary, not the global platform ontology.

## Delta Summary

### Delta 1: Replace shared `crypto-trading` with shared `trading`

The shared product capability ID changes from `crypto-trading` to `trading`.

Reason:

1. `crypto-trading` bakes one current market into the shared capability name;
2. the legal separation requirement is about trading versus non-trading, not
   about crypto versus forex inside trading; and
3. a future trading repository or domain split should share only the broad
   capability boundary with the core platform.

### Delta 2: Keep shared taxonomy at `capability -> family -> provider`

The shared platform taxonomy remains:

`capability -> family -> provider`

The shared layer does not add a platform-wide `market` or `segment` primitive.

Reason:

1. `capability` and `family` generalize across future non-trading capabilities;
2. trading-specific middle layers do not clearly generalize across messaging,
   documents, marketplace, task management, or web access; and
3. the trading domain can own richer language without forcing the rest of the
   platform to adopt it.

### Delta 3: Market taxonomy becomes trading-owned

Terms such as:

1. `crypto`
2. `forex`
3. `commodities`
4. market segment
5. instrument class
6. venue category

are trading-domain concepts.

They may appear in:

1. trading-owned public APIs;
2. trading-owned internal models;
3. trading-specific documentation; or
4. a future dedicated trading repository.

They do not become shared platform vocabulary unless a later cross-capability
need proves they belong there.

## Exact ADR Changes

### ADR 002 changes

1. Replace every top-level product capability reference to `crypto-trading`
   with `trading`.
2. Keep `messaging` unchanged.
3. Keep `family` as the shared middle layer.
4. Replace the current trading example from a crypto-specific product model to
   a broader `trading` capability whose family list is shared metadata only.
5. Add a note that `crypto`, `forex`, and `commodities` are trading-owned
   taxonomy, not shared platform taxonomy.

### ADR 003 changes

1. Replace `crypto-trading capability service` with `trading capability
   service` in the shared architecture description.
2. Keep the isolation rule unchanged: trading remains outside Agent Core.
3. Make explicit that the trading capability may be hosted in a separate
   service, separate deployment, separate domain, or separate repository.
4. Make explicit that deeper trading-domain language is owned by the trading
   capability, not Agent Core.

### ADR 004 changes

1. Change `ProductCapabilityId` from `crypto-trading | messaging` to
   `trading | messaging`.
2. Replace capability registry examples to use `trading` as the capability ID.
3. Keep `family` and `provider` registry structure intact.
4. Remove the assumption that shared registry metadata must identify crypto as
   the shared product capability.
5. Make route identity, activation, and tool ownership depend on `trading`,
   not `crypto-trading`.

## Examples After The Delta

### Shared platform taxonomy

```text
trading
  swap
    jupiter
    1inch
  orderbook
    hyperliquid
    bybit

messaging
  email
    gmail
    yahoo
  chat
    telegram
    whatsapp
  inbox
    platform
```

### Trading-owned deeper taxonomy

The trading boundary may separately describe concepts such as:

```text
markets
  crypto
  forex
  commodities
```

That deeper trading taxonomy is not part of the shared platform ontology.

## Consequences

### Positive

1. The shared capability model becomes more stable.
2. The future addition of forex or commodities no longer forces a rename of
   the shared capability boundary.
3. The current API route naming under `/capabilities/trading` becomes aligned
   with the shared taxonomy instead of treated as a legacy alias.
4. A future separate trading repository becomes easier because the shared
   boundary is thinner.

### Negative

1. Some current crypto-specific examples in docs become less concrete.
2. The trading domain must own its own deeper taxonomy document sooner.
3. If the platform later needs cross-capability segment-style constructs, a new
   shared abstraction may still be needed.

## Non-Goals

This delta does not:

1. force a specific internal trading taxonomy below the shared capability
   boundary;
2. require trading to expose crypto, forex, and commodities in every shared
   platform response;
3. split trading into multiple shared capability IDs today; or
4. change the rule that capabilities remain separately deployable isolated
   boundaries.

## Adoption Rule

If adopted, all future shared-platform drafts and implementations should:

1. use `trading` and `messaging` as the first product capability IDs;
2. keep `family` as the deepest shared taxonomy term;
3. keep market-specific trading language out of the shared platform domain
   language; and
4. push trading sub-taxonomy into trading-owned docs, contracts, or a future
   trading repository.