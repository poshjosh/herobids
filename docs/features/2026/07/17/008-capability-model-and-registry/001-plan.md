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

This plan keeps the current provider taxonomy and runtime binding family machinery intact, layers a shared product-capability registry on top, and cleans up the highest-risk naming collisions without forcing a flag-day DB rewrite.

## Verified Baseline

Current code and docs show:

1. [packages/domain/src/provider-catalog.ts](../../../../../packages/domain/src/provider-catalog.ts) owns shared provider categories such as `trading`, `swap`, and `messaging`, and derives runtime binding families `trading` and `email`.
2. [packages/db/src/agent-runtime-descriptor.ts](../../../../../packages/db/src/agent-runtime-descriptor.ts) builds readiness and default connections by runtime family, using skill `capabilityFamilies` plus provider-derived families.
3. [packages/domain/src/skills.ts](../../../../../packages/domain/src/skills.ts) uses `capabilityFamilies` only for binding-requiring domains today. `web-access`, `task-management`, `file-management`, and `programming` have none.
4. [apps/api/src/routes/capabilities/index.ts](../../../../../apps/api/src/routes/capabilities/index.ts) and [apps/api/src/routes/capabilities/trading.ts](../../../../../apps/api/src/routes/capabilities/trading.ts) expose only trading through the capability API today.
5. [apps/web/src/features/agents/agent-display.ts](../../../../../apps/web/src/features/agents/agent-display.ts) and [apps/web/src/features/agents/AgentsPage.tsx](../../../../../apps/web/src/features/agents/AgentsPage.tsx) still mix preset language with capability language. `personal-assistant` is a preset, not a product capability.
6. [apps/worker/src/agents/capability-policy.ts](../../../../../apps/worker/src/agents/capability-policy.ts) uses “capability” for per-tool policy keys such as `execute_code` and `search_web`.
7. [packages/domain/src/config/schema.ts](../../../../../packages/domain/src/config/schema.ts) uses `capabilityMode = intelligence | hybrid`, which is unrelated to product capabilities.
8. [docs/tech/agents/runtime-boundary-and-message-contract.md](../../../../tech/agents/runtime-boundary-and-message-contract.md) and [docs/tech/agents/tool-access-and-sandboxing.md](../../../../tech/agents/tool-access-and-sandboxing.md) define the stable runtime boundary and fail-closed policy model.
9. [docs/features/pending/025-agent-message-document-handling/000-notes.md](../../../../pending/025-agent-message-document-handling/000-notes.md) is directional evidence that attachments and documents belong with messaging, not as a separate top-level capability.

## ADR Decisions To Encode

| Decision | Plan choice | Consequence |
|---|---|---|
| Product capability meaning | A capability is an isolated product or service domain with its own ownership, policy, state, and API or tool surface | Stop using runtime-family or preset language as the product definition |
| First capabilities | `crypto-trading` and `messaging` | No first-class `email`, `documents`, `web-access`, or `task-management` capability in this slice |
| Email position | `email` remains a runtime binding family and current messaging channel | Do not expose `email` as the long-term top-level product capability |
| Documents position | Attachments and documents belong under messaging v1 | Avoid a third top-level capability for documents |
| Presets vs capabilities | `personal-assistant` stays a preset or archetype | Move preset metadata out of capability language |
| Registry location | Shared code in `packages/domain`, not a DB table | Avoid schema churn for static metadata |
| Runtime families | Keep `trading` and `email` as the current binding-family layer | Capability registry sits above them rather than replacing them immediately |
| Provider categories | Keep provider catalog categories distinct from capabilities and families | No semantic overloading of `categories` |
| Naming cleanup | Prefer additive aliases, helper names, and doc fixes before breaking renames | Reduce churn while removing the worst ambiguity |

## Terminology Model

| Concept | Current anchor | Intended meaning after this plan | Rollout rule |
|---|---|---|---|
| Provider category | `ProviderDefinition.categories` | Catalog and setup taxonomy such as `trading`, `swap`, `messaging` | Keep as-is |
| Runtime binding family | `RuntimeBindingFamily` in provider catalog | Connection family used for readiness, defaults, and binding requirements | Keep as-is |
| Product capability | New shared registry | Agent-facing platform domain such as `crypto-trading` or `messaging` | Add |
| Preset or archetype | `SKILL_PRESET_MAP`, `personal-assistant` | User-facing bundle of skills | Extract and rename in UI or shared metadata |
| Tool grant key | `capability` field in worker tool policy | Per-tool sandbox permission such as `execute_code` | Rename internally to tool-grant terminology |
| Runtime composition mode | `capabilityMode` in unified agent config | `intelligence` vs `hybrid` runtime behavior | Keep wire field for now, stop treating it as product capability language |

## Implementation Plan

### Phase 1 — Add the shared capability registry and separate presets from capabilities

Goal: create one shared source of truth for product capabilities without changing the DB model yet.

Deliverables:

1. Add a new domain module, preferably `packages/domain/src/capability-registry.ts`, with:
   - `ProductCapabilityId = 'crypto-trading' | 'messaging'`
   - capability definitions with display metadata, owned runtime binding families, channel metadata, and setup semantics
   - helpers such as `listProductCapabilities()`, `getProductCapability()`, and `getProductCapabilityForRuntimeFamily()`
2. Model messaging explicitly as:
   - product capability: `messaging`
   - current runtime binding family: `email`
   - current optional channel: `email`
   - current brokered user-messaging surface: `send_message`
3. Extract preset metadata from capability language into a dedicated shared module, preferably `packages/domain/src/agent-presets.ts` or `role-presets.ts`, and keep `SKILL_PRESET_MAP` as a temporary re-export if that lowers churn.
4. Add explicit comments and helper names that treat `capabilityFamilies` as runtime binding requirements, not product capabilities.
5. Export the registry and preset metadata from domain so API and web consume the same source.

Primary touchpoints:

- new `packages/domain/src/capability-registry.ts`
- new `packages/domain/src/agent-presets.ts` or equivalent
- [packages/domain/src/provider-catalog.ts](../../../../../packages/domain/src/provider-catalog.ts)
- [packages/domain/src/skills.ts](../../../../../packages/domain/src/skills.ts)
- domain index exports

Compatibility notes:

1. Do not add a DB table for capability metadata.
2. Do not rename `RuntimeBindingFamily` or provider `categories` in this phase.
3. Do not rename the persisted `capabilityFamilies` field yet; treat it as a compatibility name over binding-family requirements.

### Phase 2 — Add capability resolution on top of existing runtime-family resolution

Goal: expose product capabilities without replacing the current family-based readiness engine.

Deliverables:

1. Add a shared capability-view resolver that consumes existing runtime inputs:
   - resolved skills
   - readiness by runtime family
   - granted connections by runtime family
   - default connections by runtime family
2. Keep `packages/db/src/agent-runtime-descriptor.ts` family-centric for now, but stop duplicating interpretation logic elsewhere. The API should call a shared resolver rather than owning another ad hoc capability model.
3. Define product-capability aggregation rules:
   - `crypto-trading` capability maps directly to runtime family `trading`
   - `messaging` capability is present whenever the base messaging surface is available, with `email` exposed as a channel or binding detail rather than as the capability id
4. Fail loudly when a runtime family exists with no registry mapping or when a capability route is registered without a shared definition.
5. Extend the API capability surface:
   - [apps/api/src/routes/capabilities/index.ts](../../../../../apps/api/src/routes/capabilities/index.ts) should return shared product-capability metadata from domain
   - keep crypto-trading detail routes in [apps/api/src/routes/capabilities/trading.ts](../../../../../apps/api/src/routes/capabilities/trading.ts)
   - add a new `messaging.ts` route for capability metadata and connection surfaces backed by the `email` runtime family
6. Keep the current deep trading routes intact in this slice. The registry sits above them; it does not redesign every trading route.

Primary touchpoints:

- [packages/db/src/agent-runtime-descriptor.ts](../../../../../packages/db/src/agent-runtime-descriptor.ts)
- [packages/domain/src/platform.ts](../../../../../packages/domain/src/platform.ts)
- [packages/domain/src/runtime-composition.ts](../../../../../packages/domain/src/runtime-composition.ts)
- [apps/api/src/routes/capabilities/index.ts](../../../../../apps/api/src/routes/capabilities/index.ts)
- new `apps/api/src/routes/capabilities/messaging.ts`
- [apps/api/src/routes/agent-config-helpers.ts](../../../../../apps/api/src/routes/agent-config-helpers.ts)
- [apps/web/src/lib/api-client.ts](../../../../../apps/web/src/lib/api-client.ts)

Compatibility notes:

1. Keep runtime-family keys `trading` and `email` stable internally. The product capability name becomes `crypto-trading`, but the existing runtime family stays `trading` in this slice.
2. Prefer additive API response changes where a clean cut would force unnecessary parallel refactors. A temporary `families` plus `capabilities` overlap is acceptable if it keeps the rollout narrow.
3. Do not force a DB migration for custom skill metadata in this phase.

### Phase 3 — Update skills, setup flows, and frontend language to consume the registry

Goal: make the user-facing product model match the new registry while preserving current runtime behavior.

Deliverables:

1. Update [packages/domain/src/skills.ts](../../../../../packages/domain/src/skills.ts) so skill descriptions and comments stop implying that `email` is a top-level product capability.
2. Keep the `email` skill as a channel-specific skill that participates in the `messaging` capability.
3. Move frontend preset handling to shared preset metadata so `personal-assistant` is always treated as a preset or role, not a capability.
4. Update capability labels, pages, and setup flow wiring:
   - [apps/web/src/features/agents/agent-display.ts](../../../../../apps/web/src/features/agents/agent-display.ts)
   - [apps/web/src/features/agents/AgentsPage.tsx](../../../../../apps/web/src/features/agents/AgentsPage.tsx)
   - [apps/web/src/features/agents/AgentCapabilityPage.tsx](../../../../../apps/web/src/features/agents/AgentCapabilityPage.tsx)
   - [apps/web/src/features/agents/AgentDetailPage.tsx](../../../../../apps/web/src/features/agents/AgentDetailPage.tsx)
5. Extend [apps/web/src/features/setup/ProviderSetupForm.tsx](../../../../../apps/web/src/features/setup/ProviderSetupForm.tsx) and the matching setup API client types so `defaultCapability` can represent `messaging` as well as `trading`.
6. Keep email connection presentation channel-specific in runtime prompt context. [apps/worker/src/runtime-composition.ts](../../../../../apps/worker/src/runtime-composition.ts) should still show “Email Connections” because that block is describing a channel, not the top-level capability.
7. Update the public glossary entry in [apps/web/src/features/public-pages/content/en/docs/reference/glossary.md](../../../../../apps/web/src/features/public-pages/content/en/docs/reference/glossary.md) so a skill preset is described as a bundle of skills or a preset, not a bundle of capabilities.

Compatibility notes:

1. Keep `send_message` in the base skill.
2. Do not promote `web-access`, `task-management`, `file-management`, or `programming` into product capabilities in this slice.
3. Do not create a separate documents capability; messaging owns attachments and documents.

### Phase 4 — Clean up the highest-risk naming collisions and align docs

Goal: remove the most confusing uses of “capability” without paying for unnecessary breaking renames.

Deliverables:

1. Rename worker sandbox-policy terminology from product-capability language to tool-grant language:
   - [apps/worker/src/agents/capability-policy.ts](../../../../../apps/worker/src/agents/capability-policy.ts)
   - examples: `CapabilityGrant` -> `ToolGrant`, `CapabilityTier` -> `ToolAccessTier`, `CapabilityPolicyEngine` -> `ToolPolicyEngine`
2. Keep the wire field `capabilityMode` in [packages/domain/src/config/schema.ts](../../../../../packages/domain/src/config/schema.ts), but:
   - update comments to clarify it is runtime-composition mode
   - use clearer local aliases in new code instead of reusing product-capability language
3. Update stable docs to explicitly separate capability, runtime family, preset, and tool grant terminology:
   - [docs/tech/agents/runtime-boundary-and-message-contract.md](../../../../tech/agents/runtime-boundary-and-message-contract.md)
   - [docs/tech/agents/tool-access-and-sandboxing.md](../../../../tech/agents/tool-access-and-sandboxing.md)
   - [docs/tech/glossary.md](../../../../tech/glossary.md) if capability terms are defined there
4. Mark conflicting draft plan language as superseded, especially [007-email-and-messaging-send-capability-split/001-plan.md](../007-email-and-messaging-send-capability-split/001-plan.md), because its “email and messaging as separate capabilities” direction conflicts with this ADR.
5. If the code still reads ambiguously after the registry lands, add a later follow-up to introduce an additive alias such as `bindingFamilies` in skill APIs before attempting to rename persisted `capabilityFamilies`.

## Migration And Compatibility Strategy

1. Registry metadata is additive and code-first. No DB table and no migration are required to land Phase 1.
2. Runtime binding families remain the compatibility bridge. Existing Gmail connections still resolve to runtime family `email`; product capability `messaging` is layered above that.
3. Existing `capabilityFamilies` arrays continue to work in DB rows, API payloads, and tests. New code should treat them as binding-family metadata, not product-capability metadata.
4. Do not attempt a global rename of `capabilityMode` or `capabilityFamilies` in the first pass. Those are the two most likely places to turn a terminology cleanup into a high-churn refactor.
5. The messaging capability should not require an email connection to exist before the platform acknowledges that brokered user messaging exists. Email is a channel under messaging, not the whole capability.
6. Attachments and documents remain a follow-on within messaging. This plan only establishes the capability model and registry required to place them correctly.

## Validation Strategy

Unit tests:

1. Add domain tests for the new capability registry and family-to-capability mapping.
2. Extend [packages/db/src/agent-runtime-descriptor.test.ts](../../../../../packages/db/src/agent-runtime-descriptor.test.ts) for messaging-channel mapping and unchanged default-connection behavior by runtime family.
3. Extend [apps/worker/src/agent-capabilities.test.ts](../../../../../apps/worker/src/agent-capabilities.test.ts) only where trading detection still relies on runtime binding families.
4. Extend [apps/worker/src/runtime-composition.test.ts](../../../../../apps/worker/src/runtime-composition.test.ts) to cover messaging capability labeling while preserving “Email Connections” channel detail.

API tests:

1. Extend [apps/api/src/routes/capabilities/trading.test.ts](../../../../../apps/api/src/routes/capabilities/trading.test.ts) for shared capability-registry responses.
2. Add focused tests for the new messaging capability route.
3. Add readiness tests that prove:
   - crypto-trading still uses the `trading` runtime family
   - messaging capability reflects the brokered surface plus email-channel detail
   - missing registry mappings fail loudly

Frontend tests:

1. Extend [apps/web/src/features/agents/derive-capability-mode.test.ts](../../../../../apps/web/src/features/agents/derive-capability-mode.test.ts) only if capability-language cleanup changes helper signatures.
2. Add tests for shared preset metadata so `personal-assistant` is never treated as a product capability.
3. Add setup-form tests for `defaultCapability = 'messaging'` once the form supports it.

Full-repo validation:

1. Run the targeted Vitest slices for domain, db, api, web, and worker surfaces touched by the change.
2. Run `pnpm lint` before considering the rollout complete.
3. Grep for stale or conflicting terminology after the refactor:
   - `capabilityFamilies`
   - `capabilityMode`
   - `CapabilityGrant`
   - `personal-assistant`
   - `family: 'email'` in user-facing capability surfaces

## High-Risk Naming Collisions And Recommended Mitigations

| Collision | Why it is risky | Recommended mitigation |
|---|---|---|
| `capabilityFamilies` on skills | Looks like product capability membership, but currently means runtime binding requirements | Keep field for now, add binding-family helper names and comments, defer wire rename |
| `capability` in worker tool policy | Reads like product capability when it really means per-tool permission | Rename internal types and comments to tool-grant language |
| `capabilityMode` in unified agent config | Looks like the new capability model, but actually means runtime composition mode | Preserve wire field, clarify docs and local aliases |
| `personal-assistant` treated as a capability in UI copy | Blurs preset vs capability boundaries | Move preset metadata to a dedicated module and update labels and glossary |
| `email` as a top-level capability in drafts and prompts | Conflicts with messaging-as-capability ADR | Keep `email` as channel or binding terminology only; route all product-level labeling through the registry |

## Non-Goals

1. Replacing the provider category system.
2. Replacing runtime binding families with a new persistence model.
3. Turning every skill domain into a product capability.
4. Introducing a documents capability separate from messaging.
5. Doing a large DB or API rename of `capabilityFamilies` or `capabilityMode` in the first slice.
6. Rewriting deep trading route semantics that are already capability-specific and working.

## Expected Outcome

After these phases, the repo should have one shared definition for product capabilities, consistent terminology across runtime, API, and web, and a clean path for future messaging work such as attachments and documents without reusing `email` as the platform’s long-term top-level capability. The current implementation-facing runtime family `trading` remains as the compatibility layer beneath the product capability `crypto-trading`.