# Initial Native Capability And External Backend Registration Manifest

**Status:** draft
**Created:** 2026-07-18  
**Parent roadmap:** [Capability Implementation Roadmap](./001-roadmap.md)  
**Authority:** normative initial data for the control-plane registry and ownership manifest

## Purpose

Define the initial native-capability registry rows, the initial
external-backend registry rows, and the exhaustive tool-ownership manifest that
later phases must implement without reinterpretation.

## Scope

This doc includes:

1. the initial registry rows for native capabilities, external backends, and
   runtime-family compatibility metadata
2. the exhaustive owner assignment for every current `AgentToolName`
3. the derived-view and validation rules that keep the registry and ownership
   manifest machine-readable and exhaustive

This doc does not include:

1. runtime resolution logic
2. durable native-activation persistence or write lifecycle rules
3. external-backend invocation transport mechanics
4. backend-internal provider or persistence taxonomy

## Non-Goals

1. Do not derive ownership from skills or categories.
2. Do not introduce additional native capabilities in this roadmap.
3. Do not treat planned providers as setup-ready or actionable.
4. Do not encode external-backend provider rules as platform-core metadata.

## Dependencies

1. [Capability Implementation Roadmap](./001-roadmap.md) keeps this doc as an
   active supporting reference for later phases and the first foundations
   phase.
2. [002-capability-foundations.md](./002-capability-foundations.md),
   [003-capability-resolution-and-route-migration.md](./003-capability-resolution-and-route-migration.md),
   [004-worker-tool-visibility-enforcement.md](./004-worker-tool-visibility-enforcement.md),
   [005-trading-capability-extraction.md](./005-trading-capability-extraction.md),
   [006-messaging-capability-extraction.md](./006-messaging-capability-extraction.md),
   [007-capability-naming-cleanup.md](./007-capability-naming-cleanup.md),
   and [015-automation-backend-extraction.md](./015-automation-backend-extraction.md)
   all consume this registry and ownership data.

## Fixed Decisions

1. The initial control plane contains exactly one native capability,
   `messaging`, and two external backends, `trading` and `automation`.
2. Every current `AgentToolName` has exactly one owner in the table below.
3. `general` is an explicit temporary ownership category, not an unclassified
   fallback.
4. `core` tools remain in platform core until a later active doc changes that.
5. External-backend rows carry generic registration, transport, and readiness
   metadata only. Domain-specific provider rules stay in the external backend.
6. `automation` is an external backend whose first family is `browser-use`.
   Only tools requiring an external stateful resource with provider lifecycle
   belong to `external:automation`. Stateless web tools remain `general`.
   See [ADR 009](../../../tech/architecture/adrs/2026/08/009-automation-as-external-backend.md).

## Open Latitude

Implementation may choose the following without escalation, as long as the
fixed decisions, dependencies, acceptance criteria, and validation still hold:

1. the exact data structures used to encode the registry and ownership tables
2. helper names for derived native-capability and external-backend views
3. test placement for key-set, planned-provider, and ownership validation

## Acceptance Criteria

This supporting reference is fit for implementation use only when:

1. the registry rows below remain the single source of truth for
   native-capability and external-backend metadata in this roadmap
2. the ownership table remains exhaustive over `AgentToolName`
3. planned providers are explicitly visible as planned but never treated as
   actionable or setup-ready
4. derived control-plane views can be validated from this one manifest without
   a second manual list

## Validation

1. add or update tests that assert manifest key-set equality with
   `KNOWN_AGENT_TOOL_NAMES`
2. validate that planned providers remain non-actionable in derived native
   capability views
3. validate that external-backend views expose only generic platform metadata
4. keep `pnpm lint` as the final repo-wide validation gate for any touched code

## Rules

1. The initial control plane contains exactly one native capability,
   `messaging`, and two external backends, `trading` and `automation`.
2. Every current `AgentToolName` has exactly one owner in the table below.
3. `general` is an explicit temporary ownership category for skill-scoped tools
   that no native capability or external backend owns. It is not an
   unclassified fallback.
4. `core` tools remain in platform core. Native-capability-owned tools execute
   inside platform-owned modules. External-backend-owned tools execute across
   the backend boundary after that backend's extraction gate.
5. `publish_artifact` belongs to native messaging because it publishes a
   user-consumable delivery artifact. Price watches, market-data tools, and
   trading lifecycle tools belong to `external:trading` because their business
   semantics stay in the external domain.

## Native Capability Registry

| Capability | Canonical route ID | Activation | Family | Provider | Lifecycle | Transport mode | Runtime compatibility family |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `messaging` | `messaging` | implicit for platform-inbox or brokered native messaging; explicit for provider actions | `email` | `gmail` | available | connection-backed | `email` |
| `messaging` | `messaging` | implicit for platform-inbox or brokered native messaging; explicit for provider actions | `email` | `yahoo` | planned | connection-backed | none |
| `messaging` | `messaging` | implicit for platform-inbox or brokered native messaging; explicit for provider actions | `chat` | `telegram` | available | brokered | none |
| `messaging` | `messaging` | implicit for platform-inbox or brokered native messaging; explicit for provider actions | `chat` | `whatsapp` | planned | brokered | none |
| `messaging` | `messaging` | implicit for platform-inbox or brokered native messaging; explicit for provider actions | `inbox` | `platform` | available | internal | none |

A provider with lifecycle `planned` must be visible as planned but is not
setup-ready, connection-linkable, actionable, or capable of satisfying tool
readiness.

## External Backend Registry

| Backend | Canonical route ID | Registration mechanism | Dispatch mode | Health source | Agent prerequisites | Legacy runtime compatibility family | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `trading` | `trading` | direct API first; skill or MCP later may wrap the same boundary | shared external-backend contract | `/health/ready` | entitlement plus connection-backed readiness summary | `trading` | first repo-local backend expected under `externals/trading/` |
| `automation` | `automation` | direct API first; skill or MCP later may wrap the same boundary | shared external-backend contract | `/health/ready` | skill-gated (`system/browser`); provider health (browser pool capacity) | none | second repo-local backend expected under `externals/automation/`; first family is `browser-use` |

Canonical public paths are `/capabilities/messaging` for native-capability
routes and `/external-backends/trading` and `/external-backends/automation` for
external-backend control-plane routes.

## Exhaustive Tool Ownership

The implementation must encode this as a `Record<AgentToolName,
ToolOwnershipEntry>` rather than deriving it from skills or categories.

| Tool | Owner | Reason |
| --- | --- | --- |
| `adjust_bot_config` | `external:trading` | Trading bot configuration. |
| `adjust_risk_limits` | `external:trading` | Trading risk policy. |
| `browse_url` | `general` | Reusable web-research expertise. |
| `browse_interactive` | `external:automation` | Interactive browser automation — requires external stateful resource with provider lifecycle. |
| `check_regime` | `external:trading` | Trading market-regime analysis. |
| `check_watches` | `external:trading` | Trading price-watch evaluation. |
| `complete_task` | `general` | Reusable task-management expertise. |
| `create_bot` | `external:trading` | Trading bot lifecycle. |
| `create_task` | `general` | Reusable task-management expertise. |
| `delete_file` | `core` | Agent workspace operation. |
| `delete_memory` | `core` | Generic agent memory operation. |
| `discover_tokens` | `external:trading` | Trading market discovery. |
| `execute_code` | `general` | Reusable sandboxed programming expertise. |
| `find_instrument` | `external:trading` | Tradable-instrument resolution. |
| `get_account_summary` | `external:trading` | Trading account state. |
| `get_analytics` | `external:trading` | Trading analytics. |
| `get_bot_status` | `external:trading` | Trading bot state. |
| `get_funding_rates` | `external:trading` | Perpetual-market data. |
| `get_market_overview` | `external:trading` | Trading market overview. |
| `get_memory` | `core` | Generic agent memory operation. |
| `get_price` | `external:trading` | Trading price data. |
| `get_risk_limits` | `external:trading` | Effective trading risk limits. |
| `get_schema` | `core` | Shared schema introspection. |
| `list_bots` | `external:trading` | Trading bot lifecycle. |
| `list_files` | `core` | Agent workspace operation. |
| `list_memory_keys` | `core` | Generic agent memory operation. |
| `list_positions` | `external:trading` | Trading position state. |
| `list_tasks` | `general` | Reusable task-management expertise. |
| `list_watches` | `external:trading` | Trading price-watch state. |
| `make_http_request` | `general` | Structured HTTP client — stateless in-process fetch, no provider model. |
| `publish_artifact` | `native:messaging` | User-facing artifact delivery. |
| `read_document` | `general` | Reusable document-reading expertise. |
| `read_file` | `core` | Agent workspace operation. |
| `remove_watch` | `external:trading` | Trading price-watch lifecycle. |
| `resolve_bot` | `external:trading` | Trading bot identity resolution. |
| `resolve_task` | `general` | Reusable task-management expertise. |
| `resolve_watch` | `external:trading` | Trading price-watch identity resolution. |
| `schedule_reminder` | `general` | Reusable task-management expertise. |
| `search_tokens` | `external:trading` | Trading market discovery. |
| `search_web` | `general` | Reusable web-research expertise. |
| `send_email` | `native:messaging` | Provider-linked message delivery. |
| `send_message` | `native:messaging` | Brokered platform message delivery. |
| `set_memory` | `core` | Generic agent memory operation. |
| `start_bot` | `external:trading` | Trading bot lifecycle. |
| `stat_file` | `core` | Agent workspace operation. |
| `stop_bot` | `external:trading` | Trading bot lifecycle. |
| `submit_decision` | `external:trading` | Trading decision execution. |
| `watch_token` | `external:trading` | Trading price-watch creation. |
| `write_file` | `core` | Agent workspace operation. |

## Derived Views And Validation

The registry may derive `ownedTools` for each native capability and external
backend from this manifest. It must not define a second list manually.
Validation must fail on:

1. a missing `KNOWN_AGENT_TOOL_NAMES` entry;
2. an unknown manifest key;
3. an invalid ownership kind;
4. a native-capability owner missing from the native registry;
5. an external-backend owner missing from the external registry; or
6. a native-capability registry entry that exposes a planned provider as
   actionable.

Tests must assert that the manifest key set equals `KNOWN_AGENT_TOOL_NAMES`,
that the native messaging view contains every tool marked `native:messaging`,
that the trading backend view contains every tool marked
`external:trading`, and that the automation backend view contains every tool
marked `external:automation`.