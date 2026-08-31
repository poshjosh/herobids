# ADR 009: Automation As External Backend

**Date:** 2026-08-31
**Status:** Proposed
**Extends:** [ADR 008](./008-native-capabilities-and-external-backends.md)

## Context

ADR 008 established the distinction between native capabilities and external
backends. It named `trading` as the first external backend and `messaging` as
the current native capability. It did not classify browser automation, HTTP
client tools, or the broader automation domain.

Phase 1 of the Agent Capability Surge feature added browser automation
(`browse_interactive`) and an HTTP client tool (`make_http_request`) to the
agent tool set. These were implemented as platform-core tools gated by skills
(`system/browser` and `system/web-access`), with the browser pool running as a
separate infrastructure service.

The question arose: where does browser automation belong in the
native-versus-external model?

Browser automation has structural properties that distinguish it from simple
platform-core tools:

1. **Multiple providers** with meaningfully different characteristics:
   browserless (CDP-based cloud pool), browserbase (cloud-hosted), skyvern
   (AI-native), agent-browser (lightweight), browser-use (Python library).
2. **Provider lifecycle**: providers can be available, planned, or degraded,
   with provider-specific health and readiness models.
3. **Session lifecycle**: acquire, use, release, timeout, cleanup — stateful
   resource management beyond a single function call.
4. **Independent scaling**: browser sessions consume significant resources
   (2GB+ per concurrent session) with fundamentally different scaling
   characteristics from the agent platform.
5. **Independent billing**: browser session-minutes are metered per-agent,
   with a cost model distinct from LLM tokens or API calls.
6. **Domain-specific policy**: SSRF protection, redirect interception via CDP,
   credential/cookie management, session state persistence.

These properties parallel trading's characteristics rather than messaging's.
The platform does not want to own browser automation's domain semantics,
provider management, or scaling infrastructure as native product logic.

At the same time, not all web-facing tools share these properties.
`make_http_request`, `browse_url`, and `read_document` are stateless,
in-process operations using Node's `fetch()`. They require no session
management, no provider abstraction, no independent scaling. They are general
platform tools, not domain services.

## Decision

### 1. Automation is the second external backend

`automation` is an external backend alongside `trading`. It follows the same
boundary model established by ADR 008: repo-local under `externals/automation/`
first, treated as external from day one, with its own process, config surface,
health endpoints, and billing.

### 2. Browser-use is the first automation family

Automation uses a family-based internal structure, paralleling trading's
families (`swap`, `orderbook`) and messaging's families (`email`, `chat`,
`inbox`).

`browser-use` is the first family. Future families (RPA, screen recording,
specialized scraping services) may be added without restructuring the backend.

Providers within the `browser-use` family are substitutable implementations of
the same session-based browser interaction contract:

| Provider | Status | Characteristics |
|---|---|---|
| `browserless` | available | CDP-based, self-hosted cloud pool |
| `browserbase` | planned | Cloud-hosted, managed |
| `skyvern` | planned | AI-native browser automation |
| `agent-browser` | planned | Lightweight, agent-optimized |

### 3. Only `browse_interactive` belongs to `external:automation`

Tool ownership is narrowly scoped:

| Tool | Ownership | Reason |
|---|---|---|
| `browse_interactive` | `external:automation` | Requires external stateful resource, provider abstraction, session lifecycle |
| `make_http_request` | `general` | Stateless in-process fetch, no provider model |
| `browse_url` | `general` | Stateless in-process fetch, no provider model |
| `read_document` | `general` | Stateless in-process fetch, no provider model |
| `search_web` | `general` | Stateless in-process API call, no provider model |

The boundary between `external:automation` and `general` is whether the tool
requires an external stateful resource with its own lifecycle, scaling, and
billing — not whether it touches the network.

### 4. The platform boundary contract must be generic across external backends

The boundary contract designed for trading must also work for automation without
domain-specific extensions in the generic envelope. The automation backend
publishes its own tool payload schemas (as trading does), and the platform
dispatches through the same generic contract.

This validates ADR 008's requirement that the contract be generic.

### 5. General web tools remain platform-core, skill-gated

`make_http_request`, `browse_url`, `read_document`, and `search_web` remain
`general` tools owned by platform core, gated by the `system/web-access` skill.
They do not cross the external backend boundary. Their SSRF protection,
deny-list logic, and response handling remain platform-owned.

## Consequences

### Positive

1. The second external backend validates that the boundary contract is
   genuinely generic, not shaped to trading alone.
2. Browser automation's scaling, billing, and provider management are cleanly
   separated from the agent platform.
3. The agent platform moves closer to being purely about agents — domain
   services are external.
4. The narrow `external:automation` scope (only `browse_interactive`) avoids
   over-extracting simple tools that don't need a service boundary.

### Negative

1. The capability-foundations roadmap gains additional phases for automation
   extraction and the MCP registration layer.
2. `browse_interactive` must be migrated from platform-core
   (`apps/worker/src/tools/browser.ts`) to `externals/automation/` during
   extraction. The tool currently works; migration has a cost.
3. SSRF guard logic will exist in two places: platform-core (for general web
   tools) and `externals/automation/` (for browser-specific CDP redirect
   interception). The duplication is intentional — each side owns its own
   security policy — but must be kept in sync for shared primitives.

## Follow-Up Rules

1. New automation families added to `externals/automation/` must follow the
   family-based internal structure without requiring changes to the platform
   boundary contract.
2. The decision on whether a tool is `external:automation` vs `general` is
   based on whether it requires an external stateful resource with provider
   lifecycle — not on whether it accesses the network.
3. The MCP registration layer (when added) must be able to surface automation
   tools through the same boundary contract, as one of multiple registration
   mechanisms.
4. Session persistence (browser state across agent ticks) belongs inside the
   automation backend, not in platform core.

## Explicit Non-Goals

This ADR does not:

1. define the internal architecture of `externals/automation/` (that belongs
   in the extraction phase doc)
2. change the ownership of `make_http_request`, `browse_url`, `read_document`,
   or `search_web`
3. require automation extraction to happen before or after trading extraction
4. define the MCP registration mechanism (that is a separate concern)
5. classify `execute_code` or script execution — those remain `general` pending
   future evaluation
