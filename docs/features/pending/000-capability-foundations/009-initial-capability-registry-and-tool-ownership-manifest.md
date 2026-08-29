# Initial Capability Registry And Tool Ownership Manifest

**Status:** draft
**Created:** 2026-07-18  
**Parent roadmap:** [Capability Implementation Roadmap](./001-roadmap.md)  
**Authority:** normative initial data for the shared registry and ownership manifest

## Purpose

Define the initial shared capability registry rows and the exhaustive tool
ownership manifest that later phases must implement without reinterpretation.

## Scope

This doc includes:

1. the initial registry rows for shared capabilities, families, providers, and
   runtime binding metadata
2. the exhaustive owner assignment for every current `AgentToolName`
3. the derived-view and validation rules that keep the registry and ownership
   manifest machine-readable and exhaustive

This doc does not include:

1. runtime capability resolution logic
2. durable activation persistence or write lifecycle rules
3. public route handlers or service extraction mechanics

## Non-Goals

1. Do not derive ownership from skills or categories.
2. Do not introduce additional shared product capabilities in this roadmap.
3. Do not treat planned providers as setup-ready or actionable.

## Dependencies

1. [Capability Implementation Roadmap](./001-roadmap.md) keeps this doc as an
   active supporting reference for later phases and the first foundations
   phase.
2. [002-capability-foundations.md](./002-capability-foundations.md),
   [003-capability-resolution-and-route-migration.md](./003-capability-resolution-and-route-migration.md),
   [004-worker-tool-visibility-enforcement.md](./004-worker-tool-visibility-enforcement.md),
   [005-trading-capability-extraction.md](./005-trading-capability-extraction.md),
   [006-messaging-capability-extraction.md](./006-messaging-capability-extraction.md),
   and [007-capability-naming-cleanup.md](./007-capability-naming-cleanup.md)
   all consume this registry and ownership data.

## Fixed Decisions

1. The registry contains exactly `trading` and `messaging` in this roadmap.
2. Every current `AgentToolName` has exactly one owner in the table below.
3. `general` is an explicit temporary ownership category, not an unclassified
   fallback.
4. `core` tools remain in Agent Core until a later active doc changes that.
5. Canonical shared public paths are `/capabilities/trading` and
   `/capabilities/messaging`.

## Open Latitude

Implementation may choose the following without escalation, as long as the
fixed decisions, dependencies, acceptance criteria, and validation still hold:

1. the exact data structures used to encode the registry and ownership tables
2. helper names for derived capability-tool views
3. test placement for key-set, planned-provider, and ownership validation

## Acceptance Criteria

This supporting reference is fit for implementation use only when:

1. the registry rows below remain the single source of truth for shared
   capability metadata in this roadmap
2. the ownership table remains exhaustive over `AgentToolName`
3. planned providers are explicitly visible as planned but never treated as
   actionable or setup-ready
4. derived capability views can be validated from this one manifest without a
   second manual list

## Validation

1. add or update tests that assert manifest key-set equality with
   `KNOWN_AGENT_TOOL_NAMES`
2. validate that planned providers remain non-actionable in derived capability
   views
3. keep `pnpm lint` as the final repo-wide validation gate for any touched code

## Rules

1. The registry contains exactly `trading` and `messaging` in this
   roadmap.
2. Every current `AgentToolName` has exactly one owner in the table below.
3. `general` is an explicit temporary ownership category for skill-scoped tools
   that no product capability owns. It is not an unclassified fallback.
4. `core` tools remain in Agent Core. Capability-owned tools must execute in
   their owning service after that service's extraction gate.
5. `publish_artifact` belongs to messaging because it publishes a
   user-consumable delivery artifact. Price watches and market-data tools belong
   to trading because their business semantics are trading-specific.

## Capability Registry

| Capability | Canonical route ID | Legacy aliases | Activation | Service | Family | Provider | Lifecycle | Transport mode | Runtime binding family |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `trading` | `trading` | none | explicit | `trading` | `swap` | `jupiter` | available | connection-backed | `trading` |
| `trading` | `trading` | none | explicit | `trading` | `swap` | `1inch` | available | connection-backed | `trading` |
| `trading` | `trading` | none | explicit | `trading` | `orderbook` | `hyperliquid` | available | connection-backed | `trading` |
| `trading` | `trading` | none | explicit | `trading` | `orderbook` | `bybit` | available | connection-backed | `trading` |
| `messaging` | `messaging` | none | implicit for platform inbox; explicit for provider actions | `messaging` | `email` | `gmail` | available | connection-backed | `email` |
| `messaging` | `messaging` | none | implicit for platform inbox; explicit for provider actions | `messaging` | `email` | `yahoo` | planned | connection-backed | none |
| `messaging` | `messaging` | none | implicit for platform inbox; explicit for provider actions | `messaging` | `chat` | `telegram` | available | brokered | none |
| `messaging` | `messaging` | none | implicit for platform inbox; explicit for provider actions | `messaging` | `chat` | `whatsapp` | planned | brokered | none |
| `messaging` | `messaging` | none | implicit for platform inbox; explicit for provider actions | `messaging` | `inbox` | `platform` | available | internal | none |

Canonical public paths are `/capabilities/trading` and
`/capabilities/messaging`. A provider with lifecycle `planned` must be visible
as planned but is not setup-ready, connection-linkable, actionable, or capable
of satisfying tool readiness.

## Exhaustive Tool Ownership

The implementation must encode this as a `Record<AgentToolName,
ToolOwnershipEntry>` rather than deriving it from skills or categories.

| Tool | Owner | Reason |
| --- | --- | --- |
| `adjust_bot_config` | `trading` | Trading bot configuration. |
| `adjust_risk_limits` | `trading` | Trading risk policy. |
| `browse_url` | `general` | Reusable web-research expertise. |
| `check_regime` | `trading` | Trading market-regime analysis. |
| `check_watches` | `trading` | Trading price-watch evaluation. |
| `complete_task` | `general` | Reusable task-management expertise. |
| `create_bot` | `trading` | Trading bot lifecycle. |
| `create_task` | `general` | Reusable task-management expertise. |
| `delete_file` | `core` | Agent workspace operation. |
| `delete_memory` | `core` | Generic agent memory operation. |
| `discover_tokens` | `trading` | Trading market discovery. |
| `execute_code` | `general` | Reusable sandboxed programming expertise. |
| `find_instrument` | `trading` | Tradable-instrument resolution. |
| `get_account_summary` | `trading` | Trading account state. |
| `get_analytics` | `trading` | Trading analytics. |
| `get_bot_status` | `trading` | Trading bot state. |
| `get_funding_rates` | `trading` | Perpetual-market data. |
| `get_market_overview` | `trading` | Trading market overview. |
| `get_memory` | `core` | Generic agent memory operation. |
| `get_price` | `trading` | Trading price data. |
| `get_risk_limits` | `trading` | Effective trading risk limits. |
| `get_schema` | `core` | Shared schema introspection. |
| `list_bots` | `trading` | Trading bot lifecycle. |
| `list_files` | `core` | Agent workspace operation. |
| `list_memory_keys` | `core` | Generic agent memory operation. |
| `list_positions` | `trading` | Trading position state. |
| `list_tasks` | `general` | Reusable task-management expertise. |
| `list_watches` | `trading` | Trading price-watch state. |
| `publish_artifact` | `messaging` | User-facing artifact delivery. |
| `read_document` | `general` | Reusable document-reading expertise. |
| `read_file` | `core` | Agent workspace operation. |
| `remove_watch` | `trading` | Trading price-watch lifecycle. |
| `resolve_bot` | `trading` | Trading bot identity resolution. |
| `resolve_task` | `general` | Reusable task-management expertise. |
| `resolve_watch` | `trading` | Trading price-watch identity resolution. |
| `schedule_reminder` | `general` | Reusable task-management expertise. |
| `search_tokens` | `trading` | Trading market discovery. |
| `search_web` | `general` | Reusable web-research expertise. |
| `send_email` | `messaging` | Provider-linked message delivery. |
| `send_message` | `messaging` | Brokered platform message delivery. |
| `set_memory` | `core` | Generic agent memory operation. |
| `start_bot` | `trading` | Trading bot lifecycle. |
| `stat_file` | `core` | Agent workspace operation. |
| `stop_bot` | `trading` | Trading bot lifecycle. |
| `submit_decision` | `trading` | Trading decision execution. |
| `watch_token` | `trading` | Trading price-watch creation. |
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
that the trading view contains every tool marked `trading`.