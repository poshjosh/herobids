# Native Capabilities And External Backends

**Status:** ready
**Created:** 2026-08-29
**Parent roadmap:** [Capability Implementation Roadmap](./001-roadmap.md)

## Purpose

Define the platform model for domains that OpenAIdom does not want to own as
native product capabilities, while still allowing a repo-local intermediate
service that can later move to a separate repository and domain.

## Scope

This doc includes:

1. the distinction between native platform capabilities and external backends
2. the registration and execution model for repo-local intermediate services
3. the allowed shared modules and forbidden dependency directions for that
   boundary
4. the current-path decision that API-first integration is acceptable before
   skill or MCP packaging

This doc does not include:

1. the business semantics of any one external domain
2. a requirement to package the first external backend through skills or MCP
   immediately
3. the final extracted repository layout for the remote service

## Non-Goals

1. Do not make every domain a native OpenAIdom capability.
2. Do not let repo-local placement justify direct imports into Agent Core,
   API, web, or shared platform code.
3. Do not force skills or MCP as the first integration mechanism when direct
   API calls are sufficient.
4. Do not let the platform core absorb domain-specific policy, taxonomy,
   persistence semantics, or route meaning for an external backend.

## Dependencies

1. [Capability Implementation Roadmap](./001-roadmap.md) must route the active
   implementation path through this doc before further phase execution.
2. [program/007-implementation-entrypoint.md](./program/007-implementation-entrypoint.md)
   uses this doc as the first controlling slice in the live handoff path.
3. [program/003-spec-agent-playbook.md](./program/003-spec-agent-playbook.md)
   and [program/005-feature-inventory.md](./program/005-feature-inventory.md)
   classify this doc as the current ready slice for the feature-local rewrite.

## Fixed Decisions

1. A domain may be external even when it is temporarily implemented inside this
   repository.
2. A repo-local external domain service must be treated everywhere else in the
   platform exactly as if it already lived in another repository and domain.
3. The preferred intermediate layout is `externals/<domain>/`, not an in-core
   module or a direct import surface inside `apps/api`, `apps/worker`, or
   `apps/web`.
4. Platform code may call the external domain over an explicit boundary
   contract by direct API first; skills or MCP may later become registration
   and packaging layers over the same boundary.
5. Messaging may remain a native platform capability. Other domains may remain
   external unless the platform explicitly chooses to own them.
6. Native capability semantics, external-backend registration, and execution
   backend location are separate concerns and must not be collapsed into one
   type or one field.

## Open Latitude

Implementation may choose the following without escalation, as long as the
fixed decisions, dependencies, acceptance criteria, and validation still hold:

1. the exact service name under `externals/` for the first repo-local external
   backend
2. the HTTP auth scheme, timeout policy, and retry envelope used at the
   boundary
3. whether the first client adapter lives in `apps/worker`, `apps/api`, or a
   shared generic integration package, as long as it remains transport-only
4. the exact future packaging path for skills or MCP over the same external
   backend contract

## Separation Rules

### Native Versus External

1. A native capability is a domain the platform understands specially in its
   product model, UX, readiness, policy, and route semantics.
2. An external backend is a domain whose business meaning remains outside the
   platform core even if the runtime endpoint is temporarily hosted in this
   repository.
3. Registration mechanism is separate from both of the above. A domain may be
   reached by direct API now and later wrapped by skills or MCP without
   changing the underlying boundary.

### Required Repository Boundary

1. The intermediate external service should live under `externals/<domain>/`.
2. It must have its own runtime entrypoint, config surface, health endpoints,
   and Docker or compose service wiring.
3. It must not be imported directly into `apps/api`, `apps/worker`,
   `apps/web`, or shared platform packages.
4. All platform interaction must cross a versioned request-response contract.

### Allowed Shared Modules

Only the following may be shared across the platform core and an external
backend:

1. transport DTOs and validation schemas
2. auth and signing helpers for the boundary contract
3. generic retry, deadline, and correlation-id utilities
4. generic health and readiness envelope types
5. generic audit and invocation-envelope structures

Shared modules must not embed domain-specific rules, identifiers, or storage
models.

### Forbidden Import Directions

The following import patterns are forbidden:

1. `apps/api`, `apps/worker`, or `apps/web` importing implementation modules
   from `externals/<domain>/`
2. shared domain or utility packages importing implementation modules from
   `externals/<domain>/`
3. one external backend importing implementation modules from another external
   backend
4. the external backend importing platform-core business modules instead of
   consuming shared boundary contracts

### Platform Responsibilities

The platform core may own only:

1. generic dispatch and transport orchestration
2. generic tool visibility composition
3. generic auth, entitlement, timeout, retry, and health gating
4. generic audit and correlation plumbing
5. native capability behavior for domains the platform explicitly keeps native

The external backend owns domain policy, domain persistence, provider-specific
rules, and domain-specific tool semantics.

## Acceptance Criteria

This doc is ready to govern the rewrite only when:

1. the distinction between native capabilities and external backends is
   explicit
2. the repo-local intermediate service model is explicit and treats
   `externals/<domain>/` as externally bounded from day one
3. the allowed shared modules and forbidden import directions are explicit
4. the direct-API-first decision is explicit and does not block later skill or
   MCP packaging
5. the doc gives a concrete basis for rewriting the current feature path away
   from platform-owned domain assumptions

## Validation

1. update the roadmap, feature inventory, playbook, and implementation
   entrypoint so they point to this doc as the current active rewrite slice
2. create an implementation task list that translates these separation rules
   into concrete repo work
3. ensure no active controlling doc still requires the platform core to treat
   the first external domain as a native product capability