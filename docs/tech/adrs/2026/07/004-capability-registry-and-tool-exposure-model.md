# ADR 004: Capability Registry And Tool Exposure Model

**Date:** 2026-07-18
**Status:** Proposed

## Context

ADR 002 defined the product taxonomy:

`capability -> family -> provider`

ADR 003 defined the architectural boundary:

1. Agent Core is capability-agnostic
2. Capability Services own capability-specific domain logic

The platform still lacks one shared implementation model for:

1. how product capabilities are defined in code
2. how capability metadata reaches API and UI surfaces
3. how capability-owned tools are distinguished from core or skill-scoped tools
4. how product capability metadata maps to the existing runtime binding-family
   layer

Current metadata is split across several places:

1. provider categories and runtime binding families in
   `packages/domain/src/provider-catalog.ts`
2. skill tool requirements in `packages/domain/src/skills.ts`
3. tool metadata in `packages/domain/src/tools.ts`
4. runtime readiness and default bindings in
   `packages/db/src/agent-runtime-descriptor.ts`
5. capability API routes in `apps/api/src/routes/capabilities/`
6. runtime tool-visibility composition in
   `apps/worker/src/runtime-tool-visibility.ts`

Without a registry, each layer must keep reinterpreting the same concepts:

1. what capabilities exist
2. which families and providers belong to them
3. which tools belong to Agent Core versus a capability service
4. which runtime binding families sit underneath a product capability

That duplication creates drift and makes it harder to add new capabilities
without hardcoding special cases into API, runtime, and UI code.

## Decision

### 1. Introduce one shared capability registry in domain code

The platform will define a shared capability registry in domain code.

The registry is the canonical product-level metadata source for capabilities,
families, providers, and capability-owned tool exposure.

The registry is:

1. static product metadata
2. shared across Agent Core, capability services, API, and UI layers
3. code-first, not database-backed

The registry is **not**:

1. a store of user-specific state
2. a replacement for runtime readiness resolution
3. a replacement for the global tool catalog
4. a policy-enforcement engine

### 2. Registry entries describe product structure, not live readiness

Each capability entry must describe:

1. capability identity and display metadata
2. families under that capability
3. providers under each family
4. which runtime binding families, if any, are relevant beneath that provider
5. which tools are owned by that capability
6. setup and routing semantics needed by higher layers

Illustrative shape:

```ts
type ProductCapabilityId = 'crypto-trading' | 'messaging';

interface CapabilityRegistryEntry {
  id: ProductCapabilityId;
  displayName: string;
  description: string;
  families: CapabilityFamilyEntry[];
  ownedTools: string[];
}

interface CapabilityFamilyEntry {
  id: string;
  displayName: string;
  providers: CapabilityProviderEntry[];
}

interface CapabilityProviderEntry {
  id: string;
  displayName: string;
  runtimeBindingFamilies?: string[];
  transportMode?: 'connection-backed' | 'brokered' | 'internal';
}
```

The exact TypeScript shape may differ, but the contract must preserve those
meanings.

### 3. Initial capability entries

The initial registry must cover exactly two product capabilities:

1. `crypto-trading`
2. `messaging`

Illustrative examples:

```text
crypto-trading
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

The product registry may describe future providers before all of them are fully
implemented, but implemented and non-implemented states must be explicit in
consumer layers.

### 4. Runtime binding families remain a lower implementation layer

The capability registry sits above runtime binding families. It does not replace
them in the first slice.

Current compatibility examples:

1. product capability `crypto-trading` maps to runtime binding family `trading`
2. messaging provider `gmail` maps to runtime binding family `email`
3. messaging providers `telegram` and `platform` may have no runtime binding
   family because they are brokered or internal today

This means the registry must support providers with and without runtime binding
families.

### 5. Tool ownership is explicit and singular

Every agent-facing tool must have one ownership category:

1. **Agent Core-owned tool**
2. **Capability-owned tool**
3. **Skill-scoped general tool** that is not yet part of a product capability

Examples under the current design:

1. Core-owned:
   - memory tools
   - workspace file tools
   - schema introspection
2. Capability-owned:
   - `send_message`, `send_email` -> `messaging`
   - `submit_decision`, `find_instrument`, trading analytics and trading bot
     lifecycle tools -> `crypto-trading`
3. Skill-scoped general tools:
   - `search_web`, `browse_url`, `read_document`
   - task-management tools
   - `execute_code`

The registry must explicitly describe capability-owned tools.

It does not need to absorb every skill-scoped tool immediately.

### 6. The registry does not replace the tool catalog

The global tool catalog remains the source of truth for:

1. tool names
2. tool categories
3. tool descriptions
4. global known-tool validation

The capability registry adds product ownership and grouping metadata on top of
that catalog.

In short:

1. the tool catalog answers: "what is this tool?"
2. the capability registry answers: "which capability owns this tool?"

### 7. Tool exposure is a composition model, not a direct registry lookup

The registry does not decide the final visible tool set by itself.

Final tool visibility is composed from multiple layers:

1. Agent Core baseline tools
2. resolved skills and their `requiredTools`
3. capability-owned tool metadata from the registry
4. runtime readiness and degraded-dependency exclusions
5. per-runtime or per-agent tool policy enforcement

Illustrative flow:

```text
tool catalog
    +
capability registry
    +
resolved skills
    +
runtime readiness
    +
tool policy
    =
visible tools for this agent session
```

This preserves the current strength of the skill system while introducing
capability ownership as a first-class concept.

### 8. API and UI surfaces must consume the shared registry

User-facing capability metadata must be read from the shared registry rather
than reauthored in multiple layers.

That includes:

1. capability listing endpoints
2. per-agent capability views
3. setup and provider-link flows
4. UI capability labels and family/provider trees

The API may enrich registry output with runtime state, but it must not invent a
separate product capability model.

For isolated capabilities, the registry is shared metadata across service
boundaries. It is not a justification for collapsing capability
implementations back into one process.

### 9. The registry must fail loudly on ambiguous ownership

The registry is a boundary mechanism, not optional documentation.

These boundaries are mandatory architectural constraints, not informal
guidance. They must be enforced through appropriate automated checks,
validation in CI, and review practices suitable for the technology stack.
Convention alone is insufficient.

At minimum, the system should fail loudly when:

1. a capability-owned tool has no registry owner
2. a registry references an unknown tool
3. a capability route is added without a matching registry entry
4. a runtime binding family is mapped in code but not represented in the
   capability-resolution layer where required

## Consequences

### Positive

1. Product capability metadata gets one canonical source of truth.
2. API, runtime, and UI layers stop duplicating capability structure.
3. Capability Services can expose tools through a stable contract without
   pushing domain meaning into Agent Core.
4. Messaging can model `email`, `chat`, and `inbox` cleanly even though their
   runtime implementations differ today.
5. Future capabilities can be added by extending shared metadata rather than by
   scattering hardcoded conditionals.
6. Separately deployed capability services can still present one coherent
   product model.

### Negative

1. The first registry version will coexist with older field names such as
   `capabilityFamilies` and `capabilityMode`.
2. Some tools will remain skill-scoped but not capability-owned for a while,
   which is intentionally transitional.
3. The runtime binding-family layer will remain conceptually awkward until a
   later cleanup reduces terminology overlap.
4. Shared metadata must be versioned carefully because multiple deployable
   services consume it.

## Follow-Up Rules

1. Every new product capability must add a registry entry.
2. Every capability-owned tool must declare exactly one capability owner.
3. New user-facing capability routes and UI trees must read from the shared
   registry.
4. Runtime binding families may remain implementation-facing, but product
   capability logic must not bypass the registry.
5. Skill-scoped general tools may remain outside the registry until they become
   part of a product capability, but that status must be explicit.

## Explicit Non-Goals

This ADR does not:

1. define the final runtime binding-family model
2. replace skills as the primary tool-bundling mechanism
3. force every current tool into a product capability immediately
4. require a database table for capability metadata
5. redesign the worker tool-policy engine in this slice

## Notes For The Next Steps

This ADR is the design gate before implementation work that:

1. adds `packages/domain/src/capability-registry.ts`
2. exposes `crypto-trading` and `messaging` from shared domain metadata
3. maps `crypto-trading` to the existing runtime binding family `trading`
4. keeps messaging expressive even where runtime binding families do not exist
   yet for every provider