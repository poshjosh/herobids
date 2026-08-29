# Shared Capability Taxonomy Revision

**Status:** superseded
**Created:** 2026-08-29  
**Parent roadmap:** [Capability Implementation Roadmap](./001-roadmap.md)

This slice is superseded by
[013-native-capabilities-and-external-backends.md](./013-native-capabilities-and-external-backends.md),
which replaces the platform-owned first-slice model with the repo-local
external-backend boundary model.

## Purpose

Fix the shared capability taxonomy so it remains stable if trading moves to a
separate domain, expands beyond crypto into forex or commodities, or is later
split into a separate repository.

## Scope

This doc includes:

1. the shared taxonomy boundary for capabilities, families, and providers
2. the canonical shared capability identifiers for the first implementation
   slice
3. the rule that deeper trading taxonomy stays inside the trading boundary

This doc does not include:

1. a trading-owned internal taxonomy below the shared capability layer
2. deployment topology changes
3. new universal taxonomy terms such as `segment` or `market`
4. splitting `trading` into multiple shared product capability IDs

## Non-Goals

1. Do not force a specific internal trading taxonomy below the shared
   capability boundary.
2. Do not require shared platform responses to expose `crypto`, `forex`, or
   `commodities` as top-level shared terms.
3. Do not encode hierarchy into shared capability IDs such as
   `trading/crypto`.
4. Do not widen the shared platform ontology beyond what cross-capability needs
   can justify.

## Dependencies

1. [Capability Implementation Roadmap](./001-roadmap.md) now keeps this doc as
   superseded historical context rather than the active first executable slice.
2. [013-native-capabilities-and-external-backends.md](./013-native-capabilities-and-external-backends.md)
   and [tasks/002-external-backend-boundary-implementation-tasks.md](./tasks/002-external-backend-boundary-implementation-tasks.md)
   define the current controlling slice.

## Fixed Decisions

1. The shared product taxonomy remains `capability -> family -> provider`.
2. Shared product capability IDs for the first slice are `trading` and
   `messaging`.
3. The shared platform does not add a universal `segment`, `market`, `asset
   class`, or similar middle layer.
4. Trading-specific sub-taxonomy such as `crypto`, `forex`, `commodities`,
   instrument classes, and venue categories is capability-owned, not shared.
5. Deployment topology is orthogonal to taxonomy; the same shared taxonomy must
   work in-process and across service boundaries.

## Open Latitude

Implementation may choose the following without escalation, as long as the
fixed decisions, dependencies, acceptance criteria, and validation still hold:

1. the exact names and placement of trading-owned deeper taxonomy docs
2. the examples used to illustrate the shared taxonomy
3. capability-specific metadata extension points that do not widen the shared
   vocabulary itself

Implementation may not use open latitude to reintroduce `crypto-trading` as a
shared capability ID or to add a shared universal market layer.

## Acceptance Criteria

This taxonomy revision is retained for historical comparison only when:

1. the superseded status at the top of the doc is explicit
2. the current controlling slice is linked directly from this doc
3. readers can understand the old platform-owned first-slice model without
   mistaking it for active authority

## Validation

1. the active entry path in [000-README.md](./000-README.md),
   [001-roadmap.md](./001-roadmap.md), and
   [program/007-implementation-entrypoint.md](./program/007-implementation-entrypoint.md)
   no longer routes through this doc as the first executable slice
2. this doc links readers to
   [013-native-capabilities-and-external-backends.md](./013-native-capabilities-and-external-backends.md)
   and [tasks/002-external-backend-boundary-implementation-tasks.md](./tasks/002-external-backend-boundary-implementation-tasks.md)
   as the current controlling path

## Shared Capability Examples

| Capability | Family | Provider examples | Notes |
| --- | --- | --- | --- |
| `trading` | `swap` | `jupiter`, `1inch` | Family is shared metadata only. Deeper market taxonomy stays inside trading. |
| `trading` | `orderbook` | `hyperliquid`, `bybit` | The shared layer need not standardize whether a provider is crypto, forex, or commodities. |
| `messaging` | `email` | `gmail`, `yahoo` | Family is enough for shared platform concerns. |
| `messaging` | `chat` | `telegram`, `whatsapp` | Brokered vs connection-backed remains provider/runtime metadata, not taxonomy inflation. |
| `messaging` | `inbox` | `platform` | Internal provider owned by the messaging capability. |

## Consequences

### Positive

1. The shared platform vocabulary stays minimal and durable.
2. Trading can evolve its own language without polluting global ontology.
3. Messaging, documents, web access, task management, marketplace, and future
   capabilities fit the same model.
4. A future trading repository split becomes easier because only the capability
   contract stays shared.

### Negative

1. Some readers may expect the shared platform to encode more trading detail
   than it now does.
2. Trading-owned docs must carry more responsibility for sub-taxonomy clarity.
3. Shared API responses may need capability-specific metadata extension points
   if trading later needs to expose richer classification safely.