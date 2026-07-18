# Capability Model And Registry

**Status:** proposed  
**Created:** 2026-07-17  
**Depends on:**
- [003-gmail-oauth-connection](../003-gmail-oauth-connection/001-plan.md)
- [006-remove-unused-provider-table-and-gmail-readonly-scope](../006-remove-unused-provider-table-and-gmail-readonly-scope/001-plan.md)

**Supersedes capability direction in:**
- [007-email-and-messaging-send-capability-split](../007-email-and-messaging-send-capability-split/001-plan.md)

## Summary

Establish a shared capability registry in domain code that separates four concepts the current codebase partially overlaps:

1. provider categories for catalog and setup UI
2. runtime binding families for connection/readiness resolution
3. product capabilities for agent-facing platform domains
4. tool sandbox grants for per-tool runtime policy

The first product capabilities should be `crypto-trading` and `messaging`.

This plan now also encodes the ADR decision that declared capabilities are not
just logical groupings. `crypto-trading` and `messaging` must become separate
deployable services, Agent Core must call capability-owned tools through a
versioned cross-service contract, tool ownership must be exhaustive and
machine-readable, capability activation must be explicit, provider lifecycle
must be modeled separately from runtime readiness, and public capability routes
must migrate from legacy family-shaped names such as `trading` to canonical
product IDs such as `crypto-trading`.

## Verified Baseline

Current code and docs show:

1. [packages/domain/src/provider-catalog.ts](../../../../../packages/domain/src/provider-catalog.ts) owns shared provider categories such as `trading`, `swap`, and `messaging`, and derives runtime binding families `trading` and `email`.
2. [packages/db/src/agent-runtime-descriptor.ts](../../../../../packages/db/src/agent-runtime-descriptor.ts) builds readiness and default connections by runtime family, using skill `capabilityFamilies` plus provider-derived families.
3. [packages/domain/src/skills.ts](../../../../../packages/domain/src/skills.ts) uses `capabilityFamilies` only for binding-requiring domains today. `web-access`, `task-management`, `file-management`, and `programming` have none.
4. [apps/api/src/routes/capabilities/index.ts](../../../../../apps/api/src/routes/capabilities/index.ts) and [apps/api/src/routes/capabilities/trading.ts](../../../../../apps/api/src/routes/capabilities/trading.ts) expose only the family-named `trading` capability API today.
5. [apps/web/src/features/agents/agent-display.ts](../../../../../apps/web/src/features/agents/agent-display.ts) and [apps/web/src/features/agents/AgentsPage.tsx](../../../../../apps/web/src/features/agents/AgentsPage.tsx) still mix preset language with capability language. `personal-assistant` is a preset, not a product capability.
6. [apps/worker/src/agents/capability-policy.ts](../../../../../apps/worker/src/agents/capability-policy.ts) uses “capability” for per-tool policy keys such as `execute_code` and `search_web`.
7. [packages/domain/src/config/schema.ts](../../../../../packages/domain/src/config/schema.ts) uses `capabilityMode = intelligence | hybrid`, which is unrelated to product capabilities.
8. [docs/tech/agents/runtime-boundary-and-message-contract.md](../../../../tech/agents/runtime-boundary-and-message-contract.md) and [docs/tech/agents/tool-access-and-sandboxing.md](../../../../tech/agents/tool-access-and-sandboxing.md) define the stable runtime boundary and fail-closed policy model.
9. [docs/features/pending/025-agent-message-document-handling/000-notes.md](../../../../pending/025-agent-message-document-handling/000-notes.md) is directional evidence that attachments and documents belong with messaging, not as a separate top-level capability.
10. [packages/domain/src/tools.ts](../../../../../packages/domain/src/tools.ts) already gives the exhaustive known agent-tool universe through `KNOWN_AGENT_TOOL_NAMES`, but ownership is not modeled exhaustively today.
11. [apps/worker/src/runtime-tool-visibility.ts](../../../../../apps/worker/src/runtime-tool-visibility.ts) still derives visible tools from resolved skill `requiredTools` plus degradation, with no capability-activation gate.
12. The auto-injected base skill in [packages/domain/src/skills.ts](../../../../../packages/domain/src/skills.ts) currently exposes `send_message` to every agent, so messaging-tool activation rules must be made explicit rather than assumed.

## ADR Decisions To Encode

| Decision | Plan choice | Consequence |
|---|---|---|
| Product capability meaning | A capability is a separately deployable isolated service boundary | Agent Core must not host capability-specific implementation in-process |
| First capabilities | `crypto-trading` and `messaging` | No first-class `email`, `documents`, `web-access`, or `task-management` capability in this slice |
| Service boundary | `crypto-trading` and `messaging` start as separate deployable services | Extraction planning must include Docker or equivalent deployment boundaries from day one |
| Tool invocation contract | Capability-owned tools cross the boundary through one versioned request-result contract | Shared contract types, idempotency, auth, deadlines, and typed failures become first-slice work |
| Tool ownership | Ownership is exhaustive and machine-readable over `AgentToolName` | CI can prove exactly-one ownership and reject drift |
| Capability activation | Capability-owned tool visibility requires both ownership and active capability state | Skill membership alone is insufficient to expose capability tools |
| Provider lifecycle | Registry carries static provider lifecycle, separate from service health and tenant readiness | UI and API must not offer planned providers as actionable |
| Public route identity | Canonical public route IDs use product capability IDs such as `crypto-trading` | Legacy family-named routes such as `trading` must become explicit aliases and then be retired |
| Email position | `email` remains a runtime binding family and messaging family, not the top-level capability | Do not expose `email` as the long-term top-level product capability |
| Documents position | Attachments and documents belong under messaging v1 | Avoid a third top-level capability for documents |
| Presets vs capabilities | `personal-assistant` stays a preset or archetype | Move preset metadata out of capability language |
| Registry location | Shared code in `packages/domain`, not a DB table | Avoid schema churn for static metadata |
| Runtime families | Keep `trading` and `email` as the current binding-family layer | Capability registry sits above them rather than replacing them immediately |
| Provider categories | Keep provider catalog categories distinct from capabilities and families | No semantic overloading of `categories` |

## Terminology Model

| Concept | Current anchor | Intended meaning after this plan | Rollout rule |
|---|---|---|---|
| Provider category | `ProviderDefinition.categories` | Catalog and setup taxonomy such as `trading`, `swap`, `messaging` | Keep as-is |
| Runtime binding family | `RuntimeBindingFamily` in provider catalog | Connection family used for readiness, defaults, and binding requirements | Keep as-is |
| Product capability | New shared registry | Separately deployable isolated service boundary such as `crypto-trading` or `messaging` | Add |
| Preset or archetype | `SKILL_PRESET_MAP`, `personal-assistant` | User-facing bundle of skills | Extract and rename in UI or shared metadata |
| Tool grant key | `capability` field in worker tool policy | Per-tool sandbox permission such as `execute_code` | Rename internally to tool-grant terminology |
| Tool ownership | New ownership manifest | Exhaustive owner of every `AgentToolName`: core, general, or capability | Add |
| Capability activation | New capability resolver metadata | Whether a capability is active for a given session | Add |
| Public capability route ID | New registry field | Canonical product-facing route key such as `crypto-trading` | Add with explicit legacy aliases |
| Runtime composition mode | `capabilityMode` in unified agent config | `intelligence` vs `hybrid` runtime behavior | Keep wire field for now, stop treating it as product capability language |

## Implementation Plan

### Phase 1 — Add shared capability metadata, ownership, and contract types

Goal: create the shared metadata and contract layer required by the ADRs
without changing persistence yet.

Deliverables:

1. Add a new domain module, preferably `packages/domain/src/capability-registry.ts`, with:
   - `ProductCapabilityId = 'crypto-trading' | 'messaging'`
   - `publicRouteId` and optional legacy route aliases
   - capability activation metadata
   - family and provider metadata
   - provider lifecycle metadata: `available | planned | deprecated`
   - runtime binding-family mapping metadata
   - helpers such as `listProductCapabilities()`, `getProductCapability()`, and `getProductCapabilityForRuntimeFamily()`
2. Add an exhaustive tool-ownership manifest, preferably in `packages/domain/src/tool-ownership.ts`, typed against `AgentToolName`, with ownership kinds:
   - `core`
   - `general`
   - `capability` with one `ProductCapabilityId`
3. Add shared cross-service contract types for capability-owned tool invocation, preferably in `packages/domain/src/capability-tool-contract.ts`, covering:
   - contract version
   - request, correlation, and idempotency identifiers
   - tenant, agent, session, and actor identity
   - deadlines and retry semantics
   - typed success and typed failure payloads
4. Extract preset metadata from capability language into a dedicated shared module, preferably `packages/domain/src/agent-presets.ts` or `role-presets.ts`, and keep `SKILL_PRESET_MAP` as a temporary re-export if that lowers churn.
5. Add explicit comments and helper names that treat `capabilityFamilies` as runtime binding requirements, not product capabilities.
6. Export registry, ownership, contract, and preset metadata from domain so API, web, worker, and capability services consume the same source.

Primary touchpoints:

- new `packages/domain/src/capability-registry.ts`
- new `packages/domain/src/tool-ownership.ts`
- new `packages/domain/src/capability-tool-contract.ts`
- new `packages/domain/src/agent-presets.ts` or equivalent
- [packages/domain/src/provider-catalog.ts](../../../../../packages/domain/src/provider-catalog.ts)
- [packages/domain/src/tools.ts](../../../../../packages/domain/src/tools.ts)
- [packages/domain/src/skills.ts](../../../../../packages/domain/src/skills.ts)
- domain index exports

Compatibility notes:

1. Do not add a DB table for capability metadata.
2. Do not rename `RuntimeBindingFamily` or provider `categories` in this phase.
3. Do not rename the persisted `capabilityFamilies` field yet; treat it as a compatibility name over binding-family requirements.

### Phase 2 — Add capability resolution, activation, and route migration rules

Goal: expose product capabilities and activation state without replacing the
current family-based readiness engine yet.

Deliverables:

1. Add a shared capability-view resolver that consumes existing runtime inputs:
   - resolved skills
   - readiness by runtime family
   - granted connections by runtime family
   - default connections by runtime family
   - capability activation metadata from the registry
2. Keep [packages/db/src/agent-runtime-descriptor.ts](../../../../../packages/db/src/agent-runtime-descriptor.ts) family-centric for now, but stop duplicating interpretation logic elsewhere. API and worker code should call a shared resolver rather than owning ad hoc capability models.
3. Define product-capability aggregation and activation rules:
   - `crypto-trading` maps directly to runtime family `trading` and is explicitly activated
   - `messaging` is implicitly active for the platform inbox or brokered user-messaging path
   - `send_email` still requires messaging activation plus relevant provider or readiness state
4. Extend the API capability surface:
   - [apps/api/src/routes/capabilities/index.ts](../../../../../apps/api/src/routes/capabilities/index.ts) should return shared product-capability metadata from domain
   - add canonical route IDs such as `/capabilities/crypto-trading` and `/capabilities/messaging`
   - keep `/capabilities/trading` only as an explicit legacy alias during migration
5. Separate static provider lifecycle support from runtime enrichment:
   - registry = lifecycle metadata
   - API enrichment = service health plus tenant or agent readiness
6. Fail loudly when:
   - a runtime family exists with no registry mapping
   - a capability-owned tool has no ownership entry
   - a canonical route exists without a matching registry entry
   - a legacy alias is used without explicit declaration

Primary touchpoints:

- [packages/db/src/agent-runtime-descriptor.ts](../../../../../packages/db/src/agent-runtime-descriptor.ts)
- [packages/domain/src/platform.ts](../../../../../packages/domain/src/platform.ts)
- [packages/domain/src/runtime-composition.ts](../../../../../packages/domain/src/runtime-composition.ts)
- [apps/api/src/routes/capabilities/index.ts](../../../../../apps/api/src/routes/capabilities/index.ts)
- [apps/api/src/routes/capabilities/trading.ts](../../../../../apps/api/src/routes/capabilities/trading.ts)
- new `apps/api/src/routes/capabilities/crypto-trading.ts` or equivalent migration target
- new `apps/api/src/routes/capabilities/messaging.ts`
- [apps/api/src/routes/agent-config-helpers.ts](../../../../../apps/api/src/routes/agent-config-helpers.ts)
- [apps/web/src/lib/api-client.ts](../../../../../apps/web/src/lib/api-client.ts)

Compatibility notes:

1. Keep runtime-family keys `trading` and `email` stable internally in this phase.
2. Prefer additive API response changes where a clean cut would force unnecessary parallel refactors.
3. Do not force a DB migration for custom skill metadata in this phase.

### Phase 3 — Enforce tool ownership and capability activation in the worker

Goal: make tool visibility obey the new capability model rather than skill
membership alone.

Deliverables:

1. Update worker tool-visibility composition so a tool is visible only when:
   - it exists in the tool catalog
   - it is requested by the base runtime or a resolved skill
   - it has exactly one owner in the ownership manifest
   - its owning capability is active when capability-owned
   - readiness and degradation constraints permit it
2. Preserve the current base-skill `send_message` behavior by modeling it as a
   messaging-owned tool under implicitly active brokered messaging, not as an
   Agent Core tool.
3. Keep `send_email` gated behind provider-linked messaging readiness.
4. Stop relying on skill `requiredTools` alone as the effective visibility rule.
5. Add CI validation that the ownership manifest is exhaustive over
   `KNOWN_AGENT_TOOL_NAMES` and enforces exactly-one ownership.

Primary touchpoints:

- [apps/worker/src/runtime-tool-visibility.ts](../../../../../apps/worker/src/runtime-tool-visibility.ts)
- [packages/domain/src/skills.ts](../../../../../packages/domain/src/skills.ts)
- [packages/domain/src/tools.ts](../../../../../packages/domain/src/tools.ts)
- worker tests around capability and tool visibility

Compatibility notes:

1. Keep `send_message` in the base skill.
2. Do not promote `web-access`, `task-management`, `file-management`, or `programming` into product capabilities in this slice.
3. Do not create a separate documents capability; messaging owns attachments and documents.

### Phase 4 — Extract `crypto-trading` as the first separate deployable capability service

Goal: make `crypto-trading` the first real capability service, not just a
registry entry.

Deliverables:

1. Define the first capability-service boundary for `crypto-trading` as a
   separate deployable service, with Docker service separation or equivalent.
2. Implement capability-owned trading tool calls through the shared versioned
   invocation contract rather than in-process imports.
3. Start with the trading tools that force the contract to be real:
   - `submit_decision`
   - `find_instrument`
   - trading analytics or inspection tools as needed by the first slice
4. Enforce service authentication, tenant and actor identity, deadlines,
   idempotency, and typed failures at the service boundary.
5. Keep trading-instance authority intact behind the `crypto-trading` capability
   service.

Primary touchpoints:

- new `apps/crypto-trading/` service or equivalent package and deploy target
- Agent Core tool-call path
- [packages/domain/src/capability-tool-contract.ts](../../../../../packages/domain/src/capability-tool-contract.ts) if created
- trading capability API surfaces
- deployment and compose configuration

Compatibility notes:

1. `crypto-trading` remains the product capability while `trading` remains the internal runtime family.
2. Legacy trading routes may remain as aliases during this phase, but new product-facing surfaces should prefer `crypto-trading`.

### Phase 5 — Extract messaging as a separate deployable capability service and align UI language

Goal: make `messaging` the second real capability service and align user-facing
language with the registry.

Deliverables:

1. Define the `messaging` capability service as a separate deployable service.
2. Route `send_message`, `send_email`, and future artifact or document-delivery
   paths through the shared capability-tool contract.
3. Model provider lifecycle and service health explicitly in capability setup
   and capability detail APIs.
4. Move frontend preset handling to shared preset metadata so
   `personal-assistant` is always treated as a preset or role, not a
   capability.
5. Update capability labels, pages, and setup flow wiring:
   - [apps/web/src/features/agents/agent-display.ts](../../../../../apps/web/src/features/agents/agent-display.ts)
   - [apps/web/src/features/agents/AgentsPage.tsx](../../../../../apps/web/src/features/agents/AgentsPage.tsx)
   - [apps/web/src/features/agents/AgentCapabilityPage.tsx](../../../../../apps/web/src/features/agents/AgentCapabilityPage.tsx)
   - [apps/web/src/features/agents/AgentDetailPage.tsx](../../../../../apps/web/src/features/agents/AgentDetailPage.tsx)
   - [apps/web/src/features/setup/ProviderSetupForm.tsx](../../../../../apps/web/src/features/setup/ProviderSetupForm.tsx)
6. Keep email connection presentation channel-specific in runtime prompt
   context. [apps/worker/src/runtime-composition.ts](../../../../../apps/worker/src/runtime-composition.ts) should still show “Email Connections” because that block is describing a channel, not the top-level capability.

### Phase 6 — Clean up the highest-risk naming collisions and align docs

Goal: remove the most confusing uses of “capability” without paying for
unnecessary breaking renames.

Deliverables:

1. Rename worker sandbox-policy terminology from product-capability language to tool-grant language:
   - [apps/worker/src/agents/capability-policy.ts](../../../../../apps/worker/src/agents/capability-policy.ts)
   - examples: `CapabilityGrant` -> `ToolGrant`, `CapabilityTier` -> `ToolAccessTier`, `CapabilityPolicyEngine` -> `ToolPolicyEngine`
2. Keep the wire field `capabilityMode` in [packages/domain/src/config/schema.ts](../../../../../packages/domain/src/config/schema.ts), but:
   - update comments to clarify it is runtime-composition mode
   - use clearer local aliases in new code instead of reusing product-capability language
3. Update stable docs to explicitly separate capability, runtime family, preset, tool grant, ownership, and route-ID terminology:
   - [docs/tech/agents/runtime-boundary-and-message-contract.md](../../../../tech/agents/runtime-boundary-and-message-contract.md)
   - [docs/tech/agents/tool-access-and-sandboxing.md](../../../../tech/agents/tool-access-and-sandboxing.md)
   - [docs/tech/glossary.md](../../../../tech/glossary.md)
4. Mark conflicting draft plan language as superseded, especially [007-email-and-messaging-send-capability-split/001-plan.md](../007-email-and-messaging-send-capability-split/001-plan.md), because its “email and messaging as separate capabilities” direction conflicts with this ADR set.
5. If the code still reads ambiguously after the registry lands, add a later follow-up to introduce an additive alias such as `bindingFamilies` in skill APIs before attempting to rename persisted `capabilityFamilies`.

## Migration And Compatibility Strategy

1. Registry metadata, ownership metadata, and cross-service contract types are additive and code-first. No DB table and no migration are required to land the first phase.
2. Runtime binding families remain the compatibility bridge. Existing Gmail connections still resolve to runtime family `email`; product capability `messaging` is layered above that.
3. Existing `capabilityFamilies` arrays continue to work in DB rows, API payloads, and tests. New code should treat them as binding-family metadata, not product-capability metadata.
4. Do not attempt a global rename of `capabilityMode` or `capabilityFamilies` in the first pass. Those are the two most likely places to turn a terminology cleanup into a high-churn refactor.
5. Public route migration is additive first:
   - introduce canonical `/capabilities/crypto-trading`
   - keep `/capabilities/trading` as an explicit legacy alias
   - deprecate and later remove the alias after clients move
6. The messaging capability should not require an email connection to exist before the platform acknowledges that brokered user messaging exists. Email is a family or channel under messaging, not the whole capability.
7. `send_message` remains available through the base skill only because messaging is implicitly active for the brokered platform path. That must be modeled explicitly, not left as an accidental side effect.
8. Extract `crypto-trading` before extracting `messaging`. Trading is the first capability service and proves the boundary model.
9. Attachments and documents remain a follow-on within messaging. This plan establishes the capability model, service boundaries, and registry required to place them correctly.

## Validation Strategy

Unit tests:

1. Add domain tests for the new capability registry, route IDs and aliases, provider lifecycle metadata, and family-to-capability mapping.
2. Add tests for the exhaustive ownership manifest:
   - every `KNOWN_AGENT_TOOL_NAMES` entry has exactly one owner
   - no unknown tools appear in the ownership manifest
   - no tool has multiple owners
3. Extend [packages/db/src/agent-runtime-descriptor.test.ts](../../../../../packages/db/src/agent-runtime-descriptor.test.ts) for messaging-channel mapping and unchanged default-connection behavior by runtime family.
4. Extend [apps/worker/src/agent-capabilities.test.ts](../../../../../apps/worker/src/agent-capabilities.test.ts) for capability activation rules.
5. Extend [apps/worker/src/runtime-composition.test.ts](../../../../../apps/worker/src/runtime-composition.test.ts) to cover messaging capability labeling while preserving “Email Connections” channel detail.

API tests:

1. Extend [apps/api/src/routes/capabilities/trading.test.ts](../../../../../apps/api/src/routes/capabilities/trading.test.ts) or its migration replacement for shared capability-registry responses and alias behavior.
2. Add focused tests for the new messaging capability route.
3. Add readiness and enrichment tests that prove:
   - `crypto-trading` still uses the `trading` runtime family
   - messaging capability reflects the brokered surface plus email-family detail
   - provider lifecycle support is separate from service health and tenant readiness
   - missing registry mappings and undeclared legacy aliases fail loudly
4. Add cross-service contract integration tests for authenticated, idempotent capability-tool invocation with typed failures.

Frontend tests:

1. Extend [apps/web/src/features/agents/derive-capability-mode.test.ts](../../../../../apps/web/src/features/agents/derive-capability-mode.test.ts) only if capability-language cleanup changes helper signatures.
2. Add tests for shared preset metadata so `personal-assistant` is never treated as a product capability.
3. Add setup-form tests for canonical capability IDs, legacy alias handling where needed, and provider lifecycle rendering.
4. Add UI tests proving planned providers are visible as planned but not actionable.

Full-repo validation:

1. Run the targeted Vitest slices for domain, db, api, web, and worker surfaces touched by the change.
2. Run `pnpm lint` before considering the rollout complete.
3. Grep for stale or conflicting terminology after the refactor:
   - `capabilityFamilies`
   - `capabilityMode`
   - `CapabilityGrant`
   - `personal-assistant`
   - `family: 'email'` in user-facing capability surfaces
   - `/capabilities/trading` in product-facing route and client code
4. Validate Docker or compose wiring once the separate capability services exist.

## High-Risk Naming Collisions And Recommended Mitigations

| Collision | Why it is risky | Recommended mitigation |
|---|---|---|
| `capabilityFamilies` on skills | Looks like product capability membership, but currently means runtime binding requirements | Keep field for now, add binding-family helper names and comments, defer wire rename |
| `capability` in worker tool policy | Reads like product capability when it really means per-tool permission | Rename internal types and comments to tool-grant language |
| `capabilityMode` in unified agent config | Looks like the new capability model, but actually means runtime composition mode | Preserve wire field, clarify docs and local aliases |
| `personal-assistant` treated as a capability in UI copy | Blurs preset vs capability boundaries | Move preset metadata to a dedicated module and update labels and glossary |
| `email` as a top-level capability in drafts and prompts | Conflicts with messaging-as-capability ADR | Keep `email` as channel or binding terminology only; route all product-level labeling through the registry |
| `/capabilities/trading` as the public route name | Leaks runtime-family terminology into the product API | Introduce canonical `/capabilities/crypto-trading`, keep `trading` only as a declared legacy alias during migration |
| `send_message` in the base skill | Looks like an always-core tool even though ADR 004 makes it messaging-owned | Model messaging as implicitly active for the brokered platform path and enforce ownership separately from skill injection |

## Non-Goals

1. Replacing the provider category system.
2. Replacing runtime binding families with a new persistence model.
3. Turning every skill domain into a product capability.
4. Introducing a documents capability separate from messaging.
5. Doing a large DB or API rename of `capabilityFamilies` or `capabilityMode` in the first slice.
6. Rewriting deep trading route semantics that are already capability-specific and working.

## Expected Outcome

After these phases, the repo should have one shared definition for product
capabilities, one exhaustive ownership model for agent tools, explicit
capability activation and provider lifecycle semantics, canonical product route
IDs, and separate deployable services for `crypto-trading` and `messaging`.
The current implementation-facing runtime family `trading` remains as the
compatibility layer beneath the product capability `crypto-trading`, and
`email` remains a runtime family or messaging family rather than the top-level
product capability.