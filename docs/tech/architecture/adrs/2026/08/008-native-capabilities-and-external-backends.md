# ADR 008: Native Capabilities And External Backends

**Date:** 2026-08-29
**Status:** Proposed
**Supersedes:** [ADR 002](../07/002-capability-model-and-registry.md), [ADR 003](../07/003-agent-core-vs-capability-services.md), [ADR 004](../07/004-capability-registry-and-tool-exposure-model.md)

## Context

The July capability ADR set assumed that the platform's important product
domains would be modeled as first-class native capabilities with platform-owned
service boundaries, starting with `trading` and `messaging`.

The platform direction has now changed in a material way.

OpenAIdom may host or call domains that it does not want to own natively in
its product model. Those domains may initially be implemented in the same
repository for delivery convenience, but the platform core must treat them as
external from day one so they can later move to a separate repository and
domain without a semantic rewrite.

The immediate motivating case is `trading`:

1. the platform does not want to model trading as a native capability
2. the first integration may still be direct API calls rather than skills or
   MCP
3. the first runtime may temporarily live in the same repository, but behind a
   hard boundary such as `externals/trading/`

At the same time, some platform domains may still remain native. `messaging`
is the current example.

This means the old capability model is now too coarse. It mixed together:

1. native product semantics
2. packaging and registration mechanism
3. execution backend location

Those are now separate concerns.

## Decision

### 1. Distinguish native capabilities from external backends

The platform now distinguishes two first-class domain categories:

1. **Native capability**
2. **External backend**

A native capability is a domain the platform understands specially in its
product model, UX, activation, readiness, and route semantics.

An external backend is a domain whose business meaning remains outside the
platform core even if the runtime endpoint is temporarily hosted in the same
repository.

### 2. Registration mechanism is separate from domain category

Registration and packaging are independent of whether a domain is native or
external.

The platform may reach an external backend by:

1. direct API first
2. later skill packaging
3. later MCP packaging
4. another plugin or registry mechanism if added later

The registration mechanism must not redefine the native-versus-external model.

### 3. Repo-local external runtimes are treated as external from day one

If the first external backend is temporarily hosted in this repository, it must
still be treated everywhere else as external.

The preferred intermediate layout is:

`externals/<domain>/`

For example:

`externals/trading/`

That runtime must have:

1. its own process or service
2. its own config surface
3. its own health endpoints
4. its own persistence boundary where needed
5. no direct implementation imports into `apps/api`, `apps/worker`, `apps/web`,
   or shared platform packages

### 4. Platform core owns only generic boundary behavior for external backends

For external backends, platform core may own only generic responsibilities:

1. dispatch and transport orchestration
2. auth and signing at the boundary
3. generic timeouts, retries, and health gating
4. generic audit and correlation plumbing
5. generic tool-visibility composition
6. generic registration metadata

Platform core must not own domain-specific policy, domain-specific payload
meaning, provider-specific business rules, or domain-specific persistence
semantics for an external backend.

### 5. Shared modules across the boundary stay generic

Only generic boundary modules may be shared across platform core and an
external backend, such as:

1. transport DTOs and validation schemas for the boundary envelope
2. auth and signing helpers
3. deadline, retry, and correlation-id utilities
4. generic health and readiness envelopes
5. generic audit envelope structures
6. backend-published schema descriptors used as registration artifacts

Authoritative business payload schemas for external-domain tools remain
backend-owned even if the platform mirrors backend-published descriptors.

### 6. Native capability behavior remains explicit

Native capabilities remain allowed, but only where the platform intentionally
chooses to own a domain in-product.

`messaging` is the current native example.

Native capability semantics such as activation, provider lifecycle, readiness,
and route identity apply only to native capabilities unless a later ADR says
otherwise.

### 7. Canonical control-plane routes split by native vs external

Canonical native-capability routes use:

`/capabilities/:capabilityId`

Canonical external-backend control-plane routes use:

`/external-backends/:backendId`

The platform must not model an external backend as a canonical native-capability
route solely because the backend lives in the same repository.

### 8. Tool ownership distinguishes native and external owners

Every agent-facing tool must still have exactly one owner, but owner kinds now
distinguish between:

1. `core`
2. `general`
3. `native:<capabilityId>`
4. `external:<backendId>`

This preserves exactly-one ownership while allowing the platform to keep native
and external semantics separate.

## Consequences

### Positive

1. The platform can host an intermediate external runtime in-repo without
   letting repo layout leak into architecture.
2. Moving the first external backend to another repository and domain later
   becomes a deployment and configuration change rather than a platform
   semantic rewrite.
3. Native capability behavior stays explicit instead of being inferred from
   packaging or tool lists.
4. Direct API first is allowed without blocking later skill or MCP packaging.

### Negative

1. The original capability ADR set is no longer authoritative for domains like
   `trading`.
2. Platform docs, route models, and ownership metadata must now distinguish
   native capabilities from external backends explicitly.
3. Some transitional runtime-family and skill metadata will remain legacy terms
   for a while.

## Follow-Up Rules

1. New design work must distinguish native capabilities, external backends,
   and registration mechanisms.
2. Repo-local placement of an external backend must never justify direct
   imports into platform-core modules.
3. Platform-core code must treat `externals/<domain>/` the same way it would
   treat an off-repo service boundary.
4. Canonical control-plane routes for external backends must live under
   `/external-backends`, not `/capabilities`.
5. Shared boundary contracts may be platform-owned, but external-domain tool
   payload semantics remain backend-owned.
6. Native-capability activation state must not be reused as the control model
   for an external backend.

## Explicit Non-Goals

This ADR does not:

1. require skills or MCP as the first integration mechanism
2. define the final extracted repository layout for any one external backend
3. forbid all domain-specific code from temporarily existing in the same repo
4. change the native messaging direction by itself
