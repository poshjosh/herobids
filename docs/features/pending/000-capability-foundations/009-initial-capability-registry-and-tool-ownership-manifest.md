# Initial Capability Registry And Tool Ownership Manifest

**Status:** proposed  
**Created:** 2026-07-18  
**Parent roadmap:** [Capability Implementation Roadmap](./001-roadmap.md)  
**Authority:** normative initial data for the shared registry and ownership manifest

## Rules

1. The registry contains exactly `crypto-trading` and `messaging` in this
   roadmap.
2. Every current `AgentToolName` has exactly one owner in the table below.
3. `general` is an explicit temporary ownership category for skill-scoped tools
   that no product capability owns. It is not an unclassified fallback.
4. `core` tools remain in Agent Core. Capability-owned tools must execute in
   their owning service after that service's extraction gate.
5. `publish_artifact` belongs to messaging because it publishes a
   user-consumable delivery artifact. Price watches and market-data tools belong
   to crypto-trading because their business semantics are trading-specific.

## Capability Registry

| Capability | Canonical route ID | Legacy aliases | Activation | Service | Family | Provider | Lifecycle | Transport mode | Runtime binding family |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `crypto-trading` | `crypto-trading` | `trading` | explicit | `crypto-trading` | `swap` | `jupiter` | available | connection-backed | `trading` |
| `crypto-trading` | `crypto-trading` | `trading` | explicit | `crypto-trading` | `swap` | `1inch` | available | connection-backed | `trading` |
| `crypto-trading` | `crypto-trading` | `trading` | explicit | `crypto-trading` | `orderbook` | `hyperliquid` | available | connection-backed | `trading` |
| `crypto-trading` | `crypto-trading` | `trading` | explicit | `crypto-trading` | `orderbook` | `bybit` | available | connection-backed | `trading` |
| `messaging` | `messaging` | none | implicit for platform inbox; explicit for provider actions | `messaging` | `email` | `gmail` | available | connection-backed | `email` |
| `messaging` | `messaging` | none | implicit for platform inbox; explicit for provider actions | `messaging` | `email` | `yahoo` | planned | connection-backed | none |
| `messaging` | `messaging` | none | implicit for platform inbox; explicit for provider actions | `messaging` | `chat` | `telegram` | available | brokered | none |
| `messaging` | `messaging` | none | implicit for platform inbox; explicit for provider actions | `messaging` | `chat` | `whatsapp` | planned | brokered | none |
| `messaging` | `messaging` | none | implicit for platform inbox; explicit for provider actions | `messaging` | `inbox` | `platform` | available | internal | none |

Canonical public paths are `/capabilities/crypto-trading` and
`/capabilities/messaging`. `trading` is an alias only, never a second product
capability. A provider with lifecycle `planned` must be visible as planned but
is not setup-ready, connection-linkable, actionable, or capable of satisfying
tool readiness.

## Exhaustive Tool Ownership

The implementation must encode this as a `Record<AgentToolName,
ToolOwnershipEntry>` rather than deriving it from skills or categories.

| Tool | Owner | Reason |
| --- | --- | --- |
| `adjust_bot_config` | `crypto-trading` | Trading bot configuration. |
| `adjust_risk_limits` | `crypto-trading` | Trading risk policy. |
| `browse_url` | `general` | Reusable web-research expertise. |
| `check_regime` | `crypto-trading` | Trading market-regime analysis. |
| `check_watches` | `crypto-trading` | Trading price-watch evaluation. |
| `complete_task` | `general` | Reusable task-management expertise. |
| `create_bot` | `crypto-trading` | Trading bot lifecycle. |
| `create_task` | `general` | Reusable task-management expertise. |
| `delete_file` | `core` | Agent workspace operation. |
| `delete_memory` | `core` | Generic agent memory operation. |
| `discover_tokens` | `crypto-trading` | Trading market discovery. |
| `execute_code` | `general` | Reusable sandboxed programming expertise. |
| `find_instrument` | `crypto-trading` | Tradable-instrument resolution. |
| `get_account_summary` | `crypto-trading` | Trading account state. |
| `get_analytics` | `crypto-trading` | Trading analytics. |
| `get_bot_status` | `crypto-trading` | Trading bot state. |
| `get_funding_rates` | `crypto-trading` | Perpetual-market data. |
| `get_market_overview` | `crypto-trading` | Trading market overview. |
| `get_memory` | `core` | Generic agent memory operation. |
| `get_price` | `crypto-trading` | Trading price data. |
| `get_risk_limits` | `crypto-trading` | Effective trading risk limits. |
| `get_schema` | `core` | Shared schema introspection. |
| `list_bots` | `crypto-trading` | Trading bot lifecycle. |
| `list_files` | `core` | Agent workspace operation. |
| `list_memory_keys` | `core` | Generic agent memory operation. |
| `list_positions` | `crypto-trading` | Trading position state. |
| `list_tasks` | `general` | Reusable task-management expertise. |
| `list_watches` | `crypto-trading` | Trading price-watch state. |
| `publish_artifact` | `messaging` | User-facing artifact delivery. |
| `read_document` | `general` | Reusable document-reading expertise. |
| `read_file` | `core` | Agent workspace operation. |
| `remove_watch` | `crypto-trading` | Trading price-watch lifecycle. |
| `resolve_bot` | `crypto-trading` | Trading bot identity resolution. |
| `resolve_task` | `general` | Reusable task-management expertise. |
| `resolve_watch` | `crypto-trading` | Trading price-watch identity resolution. |
| `schedule_reminder` | `general` | Reusable task-management expertise. |
| `search_tokens` | `crypto-trading` | Trading market discovery. |
| `search_web` | `general` | Reusable web-research expertise. |
| `send_email` | `messaging` | Provider-linked message delivery. |
| `send_message` | `messaging` | Brokered platform message delivery. |
| `set_memory` | `core` | Generic agent memory operation. |
| `start_bot` | `crypto-trading` | Trading bot lifecycle. |
| `stat_file` | `core` | Agent workspace operation. |
| `stop_bot` | `crypto-trading` | Trading bot lifecycle. |
| `submit_decision` | `crypto-trading` | Trading decision execution. |
| `watch_token` | `crypto-trading` | Trading price-watch creation. |
| `write_file` | `core` | Agent workspace operation. |

## Derived Views And Validation

The registry may derive `ownedTools` for each product capability from this
manifest. It must not define a second list manually. Validation must fail on:

1. a missing `KNOWN_AGENT_TOOL_NAMES` entry;
2. an unknown manifest key;
3. an invalid ownership kind;
4. a capability owner missing from the registry; or
5. a capability registry entry that exposes a planned provider as actionable.

Tests must assert that the manifest key set equals `KNOWN_AGENT_TOOL_NAMES` and
that the crypto-trading view contains every tool marked `crypto-trading`.