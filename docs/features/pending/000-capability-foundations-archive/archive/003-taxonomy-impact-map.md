# Historical Taxonomy Impact Map

**Status:** historical  
**Created:** 2026-08-29  
**Parent roadmap:** [Capability Implementation Roadmap](../001-roadmap.md)  
**Depends on:** [Shared Capability Taxonomy Revision](../012-shared-capability-taxonomy-revision.md), [Historical Shared Trading Taxonomy Delta](./002-shared-trading-taxonomy-delta.md)

## Historical Note

This document is retained as a historical migration note.

It explains the route, activation, contract, and ownership impact of moving
from the rejected shared `crypto-trading` framing to the adopted shared
`trading` framing.

## Purpose

Map the revised taxonomy onto route IDs, activation rows, tool ownership, and
shared contracts so the implementation and migration impact is explicit before
code changes begin.

## Shared Type And Schema Deltas

| Area | Current pending design | Revised design | Exact impact |
| --- | --- | --- | --- |
| Shared capability ID | `crypto-trading` | `trading` | Replace shared `ProductCapabilityId` literal and all doc or schema references that treat `crypto-trading` as the shared capability. |
| Shared taxonomy depth | `capability -> family -> provider` | unchanged | No shared `segment` or `market` field is introduced. |
| Trading-specific deeper taxonomy | implied in shared examples | moved behind trading boundary | Shared contracts stop modeling crypto as the top-level trading capability. Trading-specific market taxonomy lives in trading-owned docs or contracts only where needed. |
| Capability-tool contract | `capabilityId: 'crypto-trading' | 'messaging'` | `capabilityId: 'trading' | 'messaging'` | Update request and response validation literals in the future shared contract module and any typed invocation clients. |
| Capability events | `capability.crypto-trading.*` | `capability.trading.*` | Rename capability-scoped audit event names in future capability-service contracts and observability docs. |

## Route ID Impact

### Decision

The shared control-plane canonical capability route stays `trading`.

That means the current route family already present in the codebase is closer to
the desired end state than the pending `/capabilities/crypto-trading` drafts.

### Canonical route mapping

| Method | Pending canonical route | Revised canonical route | Notes |
| --- | --- | --- | --- |
| GET | `/capabilities/crypto-trading` | `/capabilities/trading` | Do not introduce `/capabilities/crypto-trading` as the shared canonical route. |
| GET | `/capabilities/crypto-trading/providers` | `/capabilities/trading/providers` | Current implementation naming already aligns. |
| GET | `/capabilities/crypto-trading/connections` | `/capabilities/trading/connections` | Current implementation naming already aligns. |
| GET | `/agents/:agentId/capabilities/crypto-trading` | `/agents/:agentId/capabilities/trading` | Use `trading` as the stable control-plane capability ID. |
| GET | `/agents/:agentId/capabilities/crypto-trading/state` | `/agents/:agentId/capabilities/trading/state` | No crypto-specific shared capability path. |
| GET | `/agents/:agentId/capabilities/crypto-trading/readiness` | `/agents/:agentId/capabilities/trading/readiness` | No crypto-specific shared capability path. |
| GET | `/agents/:agentId/capabilities/crypto-trading/connections` | `/agents/:agentId/capabilities/trading/connections` | No crypto-specific shared capability path. |
| GET | `/agents/:agentId/capabilities/crypto-trading/connections/:connectionId` | `/agents/:agentId/capabilities/trading/connections/:connectionId` | No crypto-specific shared capability path. |
| GET | `/agents/:agentId/capabilities/crypto-trading/connections/:connectionId/audit` | `/agents/:agentId/capabilities/trading/connections/:connectionId/audit` | No crypto-specific shared capability path. |
| GET | `/agents/:agentId/capabilities/crypto-trading/activity` | `/agents/:agentId/capabilities/trading/activity` | No crypto-specific shared capability path. |
| GET | `/agents/:agentId/capabilities/crypto-trading/outcomes` | `/agents/:agentId/capabilities/trading/outcomes` | No crypto-specific shared capability path. |
| GET | `/agents/:agentId/capabilities/crypto-trading/positions` | `/agents/:agentId/capabilities/trading/positions` | No crypto-specific shared capability path. |
| POST | `/agents/:agentId/capabilities/crypto-trading/actions/:action` | `/agents/:agentId/capabilities/trading/actions/:action` | No crypto-specific shared capability path. |

### Route migration consequence

1. The planned `trading -> crypto-trading` canonical migration should be
   cancelled.
2. Existing `trading` control-plane routes should be treated as canonical,
   not legacy.
3. If a future separate public trading domain needs different route structure,
   that is a trading-surface decision, not a shared capability-ID rename.

## Activation Row Impact

### Shared activation table

The table shape stays the same:

```text
agent_id
capability_id
enabled
activation_version
updated_at
updated_by_actor_type
updated_by_actor_id
```

Only the shared capability ID value changes.

### Activation value mapping

| Concern | Pending value | Revised value | Exact impact |
| --- | --- | --- | --- |
| Trading activation row | `crypto-trading` | `trading` | Shared capability activation uses `trading` as the durable ID. |
| Messaging activation row | `messaging` | `messaging` | No change. |
| Existing-agent backfill rule | enable `crypto-trading` for trading-skill agents | enable `trading` for trading-skill agents | The migration predicate stays the same; only the written capability ID changes. |
| Shared per-market activation | not defined | still not defined | The shared layer does not create rows for `crypto`, `forex`, or `commodities`. |

### Activation boundary rule

If the trading domain later needs separate enablement for crypto, forex, or
commodities, that should be modeled inside the trading boundary with a
trading-owned policy or table. It should not widen the shared platform
activation taxonomy by default.

## Tool Ownership Impact

### Ownership rule

All tools currently planned as `crypto-trading`-owned become `trading`-owned at
the shared layer.

The tool itself does not become crypto-only, forex-only, or commodities-only
unless the platform later chooses to split trading into multiple shared
capabilities.

### Trading-owned tools after the taxonomy revision

| Tool | Shared owner after revision | Note |
| --- | --- | --- |
| `adjust_bot_config` | `trading` | Trading bot configuration remains owned by the trading capability. |
| `adjust_risk_limits` | `trading` | Trading risk policy remains owned by the trading capability. |
| `check_regime` | `trading` | Trading market-regime analysis remains owned by the trading capability. |
| `check_watches` | `trading` | Trading watch evaluation remains owned by the trading capability. |
| `create_bot` | `trading` | Trading bot lifecycle remains owned by the trading capability. |
| `discover_tokens` | `trading` | Current crypto-specific discovery tool stays shared-owner `trading`; deeper market scope is a trading-owned concern. |
| `find_instrument` | `trading` | Tradable instrument resolution remains owned by the trading capability. |
| `get_account_summary` | `trading` | Trading account state remains owned by the trading capability. |
| `get_analytics` | `trading` | Trading analytics remains owned by the trading capability. |
| `get_bot_status` | `trading` | Trading bot state remains owned by the trading capability. |
| `get_funding_rates` | `trading` | Current crypto-perpetual data tool stays shared-owner `trading`; market applicability remains a trading-owned concern. |
| `get_market_overview` | `trading` | Trading market overview remains owned by the trading capability. |
| `get_price` | `trading` | Trading price data remains owned by the trading capability. |
| `get_risk_limits` | `trading` | Effective trading risk limits remain owned by the trading capability. |
| `list_bots` | `trading` | Trading bot lifecycle remains owned by the trading capability. |
| `list_positions` | `trading` | Trading position state remains owned by the trading capability. |
| `list_watches` | `trading` | Trading watch state remains owned by the trading capability. |
| `remove_watch` | `trading` | Trading watch lifecycle remains owned by the trading capability. |
| `resolve_bot` | `trading` | Trading bot identity resolution remains owned by the trading capability. |
| `resolve_watch` | `trading` | Trading watch identity resolution remains owned by the trading capability. |
| `search_tokens` | `trading` | Current crypto-specific discovery tool stays shared-owner `trading`; taxonomy does not force a shared capability split. |
| `start_bot` | `trading` | Trading bot lifecycle remains owned by the trading capability. |
| `stop_bot` | `trading` | Trading bot lifecycle remains owned by the trading capability. |
| `submit_decision` | `trading` | Trading decision execution remains owned by the trading capability. |
| `watch_token` | `trading` | Current token-watch tool stays shared-owner `trading`; future cross-market expansion is trading-owned. |

### Messaging-owned tools after the taxonomy revision

| Tool | Shared owner after revision | Note |
| --- | --- | --- |
| `publish_artifact` | `messaging` | No change. |
| `send_email` | `messaging` | No change. |
| `send_message` | `messaging` | No change. |

## Concrete Code And Schema Touchpoints

| Location | Impact |
| --- | --- |
| `packages/domain/src/capability-registry.ts` | Future registry should use `trading` and `messaging` as the first shared capability IDs. |
| `packages/domain/src/tool-ownership.ts` | Future ownership manifest should encode current trading tools as owned by `trading`, not `crypto-trading`. |
| `packages/domain/src/capability-tool-contract.ts` | Future request and response schemas should validate `capabilityId: 'trading' | 'messaging'`. |
| `packages/db` activation schema and repositories | Shared activation validation should accept `trading` and `messaging`; no shared per-market activation rows. |
| `apps/api/src/routes/capabilities/trading.ts` | Already closer to the revised shared taxonomy than the pending `crypto-trading` route drafts. |
| `apps/web/src/lib/api-client.ts` | Existing `trading` capability paths remain aligned with the revised shared taxonomy. |
| `docs/tech/domain-language.md` | Replace `crypto-trading` examples with `trading` at the shared vocabulary level. |
| `docs/tech/glossary.md` | Replace `crypto-trading` with `trading` in shared capability definitions. |
| `docs/tech/architecture/adrs/2026/07/002-capability-model-and-registry.md` | Amend first capability IDs and explain that deeper trading taxonomy is trading-owned. |
| `docs/tech/architecture/adrs/2026/07/003-agent-core-vs-capability-services.md` | Replace shared `crypto-trading` language with `trading` and keep deeper trading taxonomy inside the trading boundary. |
| `docs/tech/architecture/adrs/2026/07/004-capability-registry-and-tool-exposure-model.md` | Change `ProductCapabilityId` and ownership examples from `crypto-trading` to `trading`. |
| `docs/features/pending/000-capability-foundations/008-cross-service-capability-execution-design.md` | Change capability IDs, service naming, and event examples from `crypto-trading` to `trading`. |
| `docs/features/pending/000-capability-foundations/009-initial-capability-registry-and-tool-ownership-manifest.md` | Replace shared capability rows and owners from `crypto-trading` to `trading`. |
| `docs/features/pending/000-capability-foundations/010-capability-activation-model.md` | Replace shared activation examples from `crypto-trading` to `trading`. |
| `docs/features/pending/000-capability-foundations/011-capability-route-and-response-migration-manifest.md` | Cancel the planned `trading -> crypto-trading` canonical route migration and keep `trading` as canonical in the shared control plane. |

## Implementation Consequence

The revised taxonomy reduces near-term churn.

The current codebase already uses `trading` route IDs in multiple places. Under
the revised taxonomy, those surfaces become aligned with the desired shared
capability model instead of treated as legacy names that must migrate to
`crypto-trading`.