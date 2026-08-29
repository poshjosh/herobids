# ADR 004: Capability Registry And Tool Exposure Model

**Date:** 2026-07-18
**Status:** Superseded
**Superseded by:** [ADR 008](../08/008-native-capabilities-and-external-backends.md)

This ADR is superseded by ADR 008. It assumed `trading` was a product
capability in the native platform registry and control plane. The platform now
distinguishes native capability metadata from external-backend registration and
tool ownership.

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
2. canonical public route identity and any declared legacy aliases
3. capability activation semantics
4. families under that capability
5. providers under each family
6. which runtime binding families, if any, are relevant beneath that provider
7. setup and routing semantics needed by higher layers

Illustrative shape:

```ts
type ProductCapabilityId = 'trading' | 'messaging';
type CapabilityActivationMode = 'implicit' | 'explicit';

interface CapabilityRegistryEntry {
  id: ProductCapabilityId;
   publicRouteId: ProductCapabilityId;
   legacyRouteAliases?: string[];
  displayName: string;
  description: string;
   activation: {
      mode: CapabilityActivationMode;
      implicitFamilies?: string[];
   };
  families: CapabilityFamilyEntry[];
}

interface CapabilityFamilyEntry {
  id: string;
  displayName: string;
  providers: CapabilityProviderEntry[];
}

interface CapabilityProviderEntry {
  id: string;
  displayName: string;
   lifecycle: 'available' | 'planned' | 'deprecated';
  runtimeBindingFamilies?: string[];
  transportMode?: 'connection-backed' | 'brokered' | 'internal';
}
```

The exact TypeScript shape may differ, but the contract must preserve those
meanings.

The shared registry stops at `family`. If a capability needs richer
capability-specific classification, that classification belongs inside the
capability boundary rather than in the shared registry shape by default.

Provider lifecycle in the registry is static product metadata.

Runtime availability is a separate enrichment contract and must distinguish at
least:

1. provider lifecycle support from the registry
2. capability-service health or reachability
3. provider or binding readiness for this tenant or agent

API and UI consumers must not offer setup, linking, or tool actions for a
provider whose lifecycle is `planned`, even if the registry already lists it.

### 3. Initial capability entries

The initial registry must cover exactly two product capabilities:

1. `trading`
2. `messaging`

Illustrative examples:

```text
trading
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

For canonical route identity, product capability IDs win.

Examples:

1. `/capabilities/trading` is the canonical shared control-plane route identity
2. a deeper trading-owned public surface may define additional route structure
   without renaming the shared capability ID
3. canonical public APIs must not use runtime binding-family names as the
   durable product identifier

### 4. Runtime binding families remain a lower implementation layer

The capability registry sits above runtime binding families. It does not replace
them in the first slice.

Current compatibility examples:

1. product capability `trading` maps to runtime binding family `trading`
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
   lifecycle tools -> `trading`
3. Skill-scoped general tools:
   - `search_web`, `browse_url`, `read_document`
   - task-management tools
   - `execute_code`

The authoritative ownership model must be machine-readable and exhaustive over
`AgentToolName`.

Illustrative shape:

```ts
type ToolOwnershipEntry =
   | { kind: 'core' }
   | { kind: 'general' }
   | { kind: 'capability'; capability: ProductCapabilityId };

type ToolOwnershipManifest = Record<AgentToolName, ToolOwnershipEntry>;
```

This ownership manifest is authoritative for exactly-one ownership.

The capability registry may expose a derived per-capability view of owned tools,
but CI must validate ownership from the exhaustive manifest rather than from an
optional `ownedTools` array alone.

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
3. the ownership manifest answers: "who owns every known tool, exhaustively?"

### 7. Tool exposure is a composition model, not a direct registry lookup

The registry does not decide the final visible tool set by itself.

Final tool visibility is composed from multiple layers:

1. Agent Core baseline tools
2. resolved skills and their `requiredTools`
3. capability activation state
4. capability-owned tool metadata from the registry and ownership manifest
5. runtime readiness and degraded-dependency exclusions
6. per-runtime or per-agent tool policy enforcement

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

The visibility predicate must be explicit.

A tool is visible only if all of the following are true:

1. the tool exists in the global tool catalog
2. the tool is requested by Agent Core baseline behavior or by a resolved skill
3. the tool has exactly one owner in the ownership manifest
4. if the tool is capability-owned, its owning capability is active for this
   agent session
5. any tool-specific provider, binding, or readiness requirement is satisfied
6. the tool is not excluded by degradation, policy, or runtime safety controls

Capability activation is separate from ownership.

A capability is active for a session only when one of these is true:

1. the registry marks it as implicitly active
2. the agent explicitly enables it through its resolved capability set
3. the session or runtime mode activates it by an explicit platform rule

Initial rule:

1. `messaging` is implicitly active for the platform inbox or brokered user
   messaging path, so `send_message` may remain available through the base skill
2. provider-linked messaging actions such as `send_email` still require
   messaging activation plus the relevant provider or readiness state
3. `trading` is explicitly activated, not implicit

This prevents a capability-owned tool from appearing solely because a skill
listed it, while still allowing platform-brokered user messaging to remain a
first-class capability.

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

API and UI enrichment must combine:

1. static registry metadata
2. ownership and activation metadata
3. capability-service health or reachability
4. tenant or agent-specific readiness data

These are separate states and must not be collapsed into one generic
"available" flag.

### 9. The registry must fail loudly on ambiguous ownership

The registry is a boundary mechanism, not optional documentation.

These boundaries are mandatory architectural constraints, not informal
guidance. They must be enforced through appropriate automated checks,
validation in CI, and review practices suitable for the technology stack.
Convention alone is insufficient.

At minimum, the system should fail loudly when:

1. a known tool has no ownership manifest entry
2. a tool has multiple owners
3. a registry or ownership manifest references an unknown tool
4. a capability-owned tool is missing from the owning capability view where
   required
5. a canonical capability route is added without a matching registry entry
6. a legacy capability route alias is used without being declared in the
   registry
7. a planned provider is exposed as setup-ready or actionable
8. a runtime binding family is mapped in code but not represented in the
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
7. Tool ownership, capability activation, and provider lifecycle become
   enforceable in CI rather than advisory.

### Negative

1. The first registry version will coexist with older field names such as
   `capabilityFamilies` and `capabilityMode`.
2. Some tools will remain skill-scoped but not capability-owned for a while,
   which is intentionally transitional.
3. The runtime binding-family layer will remain conceptually awkward until a
   later cleanup reduces terminology overlap.
4. Shared metadata must be versioned carefully because multiple deployable
   services consume it.
5. Public capability routes need an explicit migration plan away from existing
   family-named endpoints such as `/capabilities/trading`.

## Follow-Up Rules

1. Every new product capability must add a registry entry.
2. Every known tool must have exactly one ownership entry in the exhaustive
   ownership manifest.
3. Every capability-owned tool must declare exactly one owning capability.
4. New user-facing capability routes and UI trees must read from the shared
   registry.
5. Canonical public capability route IDs must use product capability IDs.
   Legacy aliases must be explicitly declared and deprecated.
6. Runtime binding families may remain implementation-facing, but product
   capability logic must not bypass the registry.
7. Skill-scoped general tools may remain outside the registry until they become
   part of a product capability, but that status must be explicit.
8. Capability-owned tool visibility must require both ownership and capability
   activation; skill membership alone is insufficient.
9. Provider lifecycle support, capability-service health, and binding readiness
   must be modeled as separate states.

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
2. adds an exhaustive tool-ownership manifest typed against `AgentToolName`
3. exposes `trading` and `messaging` from shared domain metadata
4. maps `trading` to the existing runtime binding family `trading`
5. keeps messaging expressive even where runtime binding families do not exist
   yet for every provider
6. defines canonical public capability route IDs and temporary legacy aliases
7. defines capability activation and provider lifecycle enrichment rules