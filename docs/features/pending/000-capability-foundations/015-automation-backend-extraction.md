# Repo-Local External Automation Backend

**Status:** draft
**Created:** 2026-08-31
**Parent roadmap:** [Capability Implementation Roadmap](./001-roadmap.md)
**Prerequisite:** [First Repo-Local External Trading Backend](./005-trading-capability-extraction.md)
**Normative inputs:** [Native Capabilities And External Backends](./013-native-capabilities-and-external-backends.md), [Cross-Service Capability Execution Design](./008-cross-service-capability-execution-design.md), [Initial Capability Registry And Tool Ownership Manifest](./009-initial-capability-registry-and-tool-ownership-manifest.md), [ADR 009](../../../tech/architecture/adrs/2026/08/009-automation-as-external-backend.md)

## Purpose

Establish `automation` as the second repo-local external backend, expected to
live under `externals/automation/`, following the same boundary model proven by
the trading extraction. This validates that the external-backend boundary
contract is genuinely generic and not shaped to a single domain.

## Scope

This phase includes:

1. the repo-local external backend boundary for `automation`
2. a family-based internal structure, starting with `browser-use`
3. transport-only platform adapters for automation-owned tool invocation
4. strict no-direct-import enforcement for the repo-local boundary
5. migration of `browse_interactive` from platform core to the automation
   backend
6. provider abstraction within the `browser-use` family
7. session lifecycle management (acquire, use, release, timeout, cleanup)
8. session state persistence (cookie/credential save/restore across agent
   ticks)
9. automation-specific billing and metering
10. automation-specific security policy (SSRF, CDP redirect interception)

This phase does not include:

1. native messaging hardening
2. MCP registration layer (covered by
   [016-mcp-registration-layer.md](./016-mcp-registration-layer.md))
3. changes to general web tools (`make_http_request`, `browse_url`,
   `read_document`, `search_web`) which remain platform-core `general` tools
4. script execution (remains in the Agent Capability Surge feature as a
   `general` tool enhancement)
5. global terminology cleanup or runtime-family renames

## Non-Goals

1. Do not model automation as a native platform capability.
2. Do not allow repo-local placement to justify direct imports into
   `apps/api`, `apps/worker`, `apps/web`, or shared platform packages.
3. Do not move general web tools (`make_http_request`, `browse_url`,
   `read_document`, `search_web`) into the automation backend. These are
   stateless, in-process operations that do not need a service boundary.
4. Do not block on skills or MCP before direct API integration works.
5. Do not force all families to exist before the first family is extracted.

## Dependencies

1. [Capability Implementation Roadmap](./001-roadmap.md) fixes this phase after
   [005-trading-capability-extraction.md](./005-trading-capability-extraction.md).
2. [005-trading-capability-extraction.md](./005-trading-capability-extraction.md)
   must first prove the external-backend boundary contract with trading so the
   same contract can be reused for automation without domain-specific
   extensions.
3. [013-native-capabilities-and-external-backends.md](./013-native-capabilities-and-external-backends.md)
   fixes the external boundary model this phase must implement.
4. [008-cross-service-capability-execution-design.md](./008-cross-service-capability-execution-design.md)
   remains the binding normative input for the invocation boundary, auth,
   deadline, and idempotency rules.
5. [009-initial-capability-registry-and-tool-ownership-manifest.md](./009-initial-capability-registry-and-tool-ownership-manifest.md)
   defines `browse_interactive` as owned by `external:automation`.
6. [ADR 009](../../../tech/architecture/adrs/2026/08/009-automation-as-external-backend.md)
   fixes the architectural decision that automation is an external backend and
   that only `browse_interactive` belongs to `external:automation`.

## Fixed Decisions

1. `automation` is the second external backend `backendId`, not a native
   capability ID.
2. The preferred intermediate runtime lives under `externals/automation/`.
3. The automation backend uses a family-based internal structure. `browser-use`
   is the first family.
4. Only `browse_interactive` is owned by `external:automation`. General web
   tools remain `general` and platform-core-owned.
5. Platform code may share only transport DTOs, auth helpers, generic retry or
   deadline utilities, health or readiness envelopes, and audit envelopes.
6. All platform interaction crosses the external-backend contract by direct API
   first.
7. Domain-specific policy (SSRF via CDP, session lifecycle, provider selection,
   credential management) remains inside the external backend.
8. Providers within the `browser-use` family are substitutable implementations
   of the same session-based browser interaction contract.

## Open Latitude

Implementation may choose the following without escalation, as long as the
fixed decisions, dependencies, acceptance criteria, and validation still hold:

1. the exact adapter boundary inside platform-core dispatch for automation
   invocation
2. external service packaging, internal request plumbing, and compose wiring
3. authentication and idempotency helper layout that still satisfies the
   shared contract
4. the exact internal module boundaries within each family
5. whether the browser pool infrastructure service (browserless) is managed by
   the automation backend or runs as a separate infrastructure service that the
   automation backend consumes
6. test placement across automation, worker, API, and integration suites

## Acceptance Criteria

This phase is complete only when:

1. `automation` runs as a separate repo-local external backend with its own
   health endpoints
2. platform-core code no longer directly imports implementation modules from
   `externals/automation/`
3. `browse_interactive` executes through the shared external-backend invocation
   contract
4. the same generic boundary contract used for trading works for automation
   without domain-specific extensions in the generic envelope
5. the `browser-use` family has a provider abstraction that supports swapping
   browserless for another provider without changes outside
   `externals/automation/`
6. session lifecycle management (acquire, use, release, timeout, cleanup) is
   owned by the automation backend
7. session state persistence (cookie/credential save/restore) is owned by the
   automation backend, not platform core
8. automation-specific SSRF policy (including CDP `Fetch.requestPaused`
   redirect interception) is owned by the automation backend
9. automation-specific billing events are emitted by the automation backend and
   consumable by the platform for aggregation
10. the configured automation backend base URL can move off-repo without
    semantic rewrites in platform-core code
11. the automation backend survives an independent restart without causing
    agent-visible errors beyond the health-gating window: `browse_interactive`
    becomes hidden during restart and visible again after `/health/ready`
    returns

## Validation

1. add integration tests for authenticated external-backend invocation of
   `browse_interactive` through the boundary contract
2. add session lifecycle tests: acquire, use across multiple tool calls within
   a tick, release on close or tick end, timeout enforcement
3. add provider abstraction tests: mock provider swap does not require changes
   outside the `browser-use` family
4. add SSRF tests specific to CDP redirect interception (distinct from
   platform-core SSRF tests for general web tools)
5. add session state persistence tests: save state at tick end, restore at next
   tick start, handle stale/expired state
6. run repository checks that fail on direct imports from
   `externals/automation/`
7. add a restart-resilience integration test that restarts the automation
   backend mid-session and confirms: (a) in-flight invocations return
   `upstream.transient` or `deadline.expired`, (b) the platform removes
   `browse_interactive` from visibility within one health-check cycle,
   (c) the tool reappears after the backend is healthy again
8. run targeted automation, API, worker, and domain tests
9. run `pnpm lint`

## Deliverables

1. a deployable `externals/automation/` runtime with family-based internal
   structure
2. a transport-only platform adapter for external-backend automation tool
   invocation (reusing the generic adapter pattern from trading)
3. the `browser-use` family implementation including:
   - provider port and browserless adapter (migrated from platform core)
   - session manager with lifecycle rules
   - session state persistence (save/restore)
   - SSRF and security policy (migrated and extended from platform core)
   - `browse_interactive` tool handler (migrated from platform core)
4. boundary authentication and authorization
5. idempotency, deadlines, and typed failures enforced through the contract
6. automated enforcement of the no-direct-import rule
7. docker-compose wiring for the automation backend as a separate service
8. billing event emission for browser session-minutes

## Implementation Notes

### Family-based internal structure

```
externals/automation/
├── src/
│   ├── server.ts                    # entrypoint, routes to families
│   ├── health.ts                    # aggregated health across families
│   ├── config.ts                    # service-level config
│   │
│   ├── families/
│   │   └── browser-use/
│   │       ├── port.ts              # BrowserSessionProvider interface
│   │       ├── session-manager.ts   # session lifecycle, pool management
│   │       ├── state.ts             # cookie/credential save/restore
│   │       ├── security.ts          # SSRF + CDP redirect interception
│   │       ├── providers/
│   │       │   ├── browserless.ts   # current implementation
│   │       │   └── (future: browserbase.ts, skyvern.ts)
│   │       └── tools/
│   │           └── browse-interactive.ts
│   │
│   ├── shared/
│   │   ├── ssrf-guard.ts            # common SSRF primitives
│   │   └── billing.ts              # metering abstraction
│   │
│   └── boundary/
│       └── contract.ts              # request/response types
│
├── config/
│   └── default.yaml
├── Dockerfile
└── docker-compose.service.yaml
```

Adding a new family means adding a directory under `families/`. The server
entrypoint routes tool calls to the appropriate family based on tool ownership.
Families do not import from each other.

### Migration from platform core

The following platform-core modules move to `externals/automation/`:

| Platform-core location | Destination |
|---|---|
| `apps/worker/src/tools/browser.ts` | `externals/automation/src/families/browser-use/tools/browse-interactive.ts` |
| `packages/domain/src/ports/browser-pool.ts` | `externals/automation/src/families/browser-use/port.ts` |
| Browser pool adapter (venue or infrastructure package) | `externals/automation/src/families/browser-use/providers/browserless.ts` |

SSRF guard primitives (`isHostPrivate`, IP validation) may be duplicated or
extracted to a shared utility. The platform core retains its own copy for
general web tools. The automation backend owns its copy for CDP-specific
redirect interception. The duplication is intentional — each side owns its own
security policy.

### Boundary pattern

Reuse the generic external-backend invocation client proven by the trading
extraction. The automation backend is a second consumer of the same client
adapter, differing only in `backendId`, base URL, and signing key. If the
trading extraction client is not yet generic enough, the automation extraction
surfaces that gap.

### No-direct-import rule

`apps/api`, `apps/worker`, `apps/web`, and shared packages must not import
implementation modules from `externals/automation/`. Repo-local placement is an
operational convenience only. It does not soften the boundary.

### Backend authority

Session lifecycle, provider selection, credential/cookie management,
browser-specific SSRF policy, and session state persistence rules stay in
`externals/automation/`. Platform-core code owns only generic dispatch, auth,
entitlement, health or readiness gating, visibility composition, and audit
plumbing.

### Operational readiness

The general operational readiness requirements from
[014-operational-readiness-for-external-backends.md](./014-operational-readiness-for-external-backends.md)
apply to the automation backend. Automation-specific considerations:

1. Browser sessions consume significant resources (2GB+ per concurrent
   session). The health endpoint must report session capacity and queue depth.
2. Session timeout enforcement is safety-critical — a leaked browser session
   consumes resources until the container is restarted.
3. The restart-resilience test must confirm that active browser sessions are
   cleaned up on backend restart and that agents receive clear error signals
   rather than hanging connections.
