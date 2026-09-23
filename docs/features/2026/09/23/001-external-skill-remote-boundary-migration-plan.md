# External Skill Remote-Boundary Migration Plan

**Status:** superseded, non-governing discovery draft. Do not implement from this document.
**Date:** 2026-09-23
**Superseded by:** [ADR 015](../../../../tech/architecture/adrs/2026/09/015-external-backend-skill-registration.md)
**Scope:** Replace Herobids-owned `system/trading` and related first-party
trading skill definitions with a generic external-skill-to-remote-backend
registration model. Traderton is the first backend registered through that
model; it is not a platform special case.

> This draft was written before the vocabulary, discovery gate, and code-level
> ownership audit were settled. It uses the rejected term `RemoteBoundary` and
> sequences implementation prematurely. It is retained only as investigation
> history; ADR 015 is authoritative for the current direction.

## Objective And Decisions

1. Herobids is an agent platform with arbitrary external skills installed and
   resolved through the existing skills.sh path. It is not a trading product.
   It retains generic skill installation, source-reference resolution, remote
   dispatch, signed transport, health/readiness gating, entitlement assertion,
   audit/correlation, and visibility composition only.
2. A `RemoteBoundary` is a generic external-backend registration plus client
   dispatch abstraction. Do not introduce a `TradertonBoundary`, a
   `TradingBackend`, or a `trading` branch in generic platform code.
3. An operator allowlists a backend identity, endpoint, credential references,
   trusted descriptor signing keys, and source skill references. A backend
   publishes the signed, versioned descriptor that binds those source refs to
   its instructions and tool registrations. The backend descriptor cannot
   self-register an endpoint, expand the allowlist, or replace the operator's
   trust root.
4. Tool and skill instructions, tool descriptions, input schemas, domain
   documentation, pricing, and domain policy are backend-owned artifacts.
   Herobids may cache verified opaque artifacts for availability, but must not
   seed, rewrite, or curate domain instructions in `SYSTEM_SKILLS`, database
   skill revisions, prompt presets, or product copy.
5. The existing `@herobids/domain/traderton` contract/client is a temporary
   concrete implementation. Replace it with the shared external-backend
   protocol specified in Capability Foundations document 008. Since there is
   no active deployment or data, remove the old endpoint/client/config shape
   rather than run a compatibility bridge.
6. Update ADR 008 from proposed to accepted only with the companion decision
   below. It remains the architecture authority; the new ADR must narrow its
   scope to external skills as registrations and remote boundaries as generic
   deep-integration bindings. It must not record any Traderton-only exception.

## Target Data Model

Implement these generic domain types and schemas before changing runtime
behavior. Names are illustrative; final names must remain domain-neutral.

```ts
type OperatorRemoteBackendRegistration = {
  backendId: string;
  enabled: boolean;
  endpoint: { baseUrl: string; invocationPath: string; statusPathTemplate: string };
  callerIdentity: { serviceId: string; keyId: string; hmacSecretRef: string };
  descriptorTrust: {
    allowedKeyIds: string[];
    publicKeys: Record<string, string>;
    maxAgeMs: number;
    pinnedDigest?: string;
  };
  sourceSkills: Array<{ ref: string; revision?: string; enabled: boolean }>;
  health: { readyPath: string; intervalMs: number; failureThreshold: number };
};

type RemoteBackendDescriptorV1 = {
  descriptorVersion: '1.0';
  backendId: string;
  descriptorId: string;
  issuedAt: string;
  expiresAt: string;
  sourceSkills: Array<{
    ref: string;
    revision: string;
    instructions: { uri: string; sha256: string };
  }>;
  tools: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    visibilityRequirements?: string[];
  }>;
  signature: { keyId: string; algorithm: 'ed25519'; value: string };
};
```

The platform validates only the generic envelope, JSON-schema structural
limits, signature, expiry, key pin, duplicate tool names, and agreement with
the operator registration. It does not interpret tool payload fields,
instructions, provider names, risk concepts, or backend readiness reasons.
Persist only generic registration/cache/audit state if persistence is needed;
do not add backend tool definitions to `skills`, `skill_revisions`, or a new
trading-flavoured database table.

## Implementation Tasks

1. **Record the architecture and legal product boundary first.**
   - Modify [ADR 008](../../../../tech/architecture/adrs/2026/08/008-native-capabilities-and-external-backends.md)
     to mark the native/external split accepted, without changing its generic
     rule set.
   - Add a succeeding ADR under `docs/tech/architecture/adrs/2026/09/` for
     external skill registrations and `RemoteBoundary` dispatch. State the
     allowlist-plus-signed-descriptor trust model, no domain policy in core,
     descriptor cache/expiry behavior, and removal of first-party domain
     instruction seeds.
   - Reconcile or retire the superseded trading-specific portions of pending
     Capability Foundations documents 005 and tasks/002. Keep documents 008,
     009, 013, and 014 as generic contracts, but replace `externals/trading`
     assumptions with remote, arbitrary backend language where they conflict.
   - Dependency: complete this decision before defining code contracts, so the
     protocol does not accidentally preserve a Traderton-only API.

2. **Add generic remote-boundary contracts and registry ownership.**
   - Add `packages/domain/src/remote-boundary-contract.ts` with strict Zod
     schemas for registration, descriptor, signed invocation, terminal result,
     invocation status, health summary, and generic failure codes. Export it
     from `packages/domain/src/index.ts`.
   - Add `packages/domain/src/remote-boundary-registry.ts` containing the
     pure registration lookup, source-skill-ref-to-`backendId` resolution,
     descriptor verification inputs, ownership checks, and exhaustive
     validation. Its only key types are generic IDs, refs, tool names, and
     availability state.
   - Refactor the planned ownership manifest out of
     `packages/domain/src/skills.ts` and `SYSTEM_SKILLS` ordering. Extend
     `packages/domain/src/tools.ts`/`KNOWN_AGENT_TOOL_NAMES` and the future
     dynamic-tool path so tool ownership comes from an active verified
     descriptor, not a hard-coded trading list. Preserve static ownership only
     for core/native/general platform tools.
   - Add domain tests for invalid/expired/untrusted descriptors, source-ref
     mismatch, duplicate tool names, descriptor key rotation, and an arbitrary
     two-backend fixture proving no backend-name branch exists.
   - Dependency: task 1; tasks 3 through 6 consume these types.

3. **Replace the concrete Traderton transport client with `RemoteBoundary`.**
   - Refactor `packages/domain/src/traderton/{contract,sign,client,index}.ts`
     into a domain-neutral server-only subpath such as
     `packages/domain/src/remote-boundary/`. Rename
     `TradertonClient`, `TradertonSubject`, and configuration/result types to
     generic boundary equivalents. Delete the old subpath after all imports
     move; do not leave a type alias or runtime compatibility facade.
   - Update `apps/api/src/index.ts`, `apps/worker/src/index.ts`,
     `apps/worker/src/agent.ts`, `apps/worker/src/traderton/{read-adapter,write-adapter,hybrid-price-adapter}.ts`,
     and their tests to depend on a generic dispatch port supplied by the
     resolved `backendId`. Move adapters to `apps/{api,worker}/src/remote-boundaries/`
     only where they perform generic result mapping; delete code whose names
     or branches encode Traderton/trading behavior.
   - Replace `BoundaryConfigSchema` in
     `packages/domain/src/config/schema.ts`, its environment overrides in
     `apps/api/src/config.ts` and worker counterpart, and `config/*.yaml`
     with an `remoteBackends` collection of generic registrations. Secrets
     remain environment/secret references; configuration contains no raw
     secret, trading risk value, or Traderton-specific field name.
   - Align Traderton's `packages/boundary/src/{contract,auth,app,dispatcher}.ts`
     to the generic `/internal/v1/external-tools:*` envelope and add a signed
     descriptor endpoint. It accepts the generic caller assertion, validates
     only its own tool names/payloads, and publishes its own skill/tool
     artifacts. This is a protocol migration, not a Herobids adapter.
   - Dependency: task 2. Do this before dynamic tools or skill-resolution
     changes so every later call uses one protocol.

4. **Implement verified descriptor retrieval, health, and generic dynamic proxy tools.**
   - Add `apps/worker/src/remote-boundaries/` for descriptor retrieval/cache,
     HMAC transport, health polling, deadline/retry/idempotency handling, and
     generic dispatch. Add the API equivalent only for control-plane routes
     that invoke a remote tool.
   - Refactor `apps/worker/src/tools/index.ts` and `ToolRegistry` so a verified
     descriptor produces dynamic proxy `AgentTool` registrations. The proxy
     forwards the opaque payload with the selected backend ID; it cannot
     import `tools/trading.ts`, `bots.ts`, `market-data.ts`, or any other
     backend implementation to validate or enrich backend payloads.
   - Refactor `packages/db/src/agent-runtime-descriptor.ts` so DB skill
     revisions remain local-skill data, while external installed skill refs
     resolve through the registry into descriptor-backed runtime skills. Do
     not infer backend ownership from required tool names or the `trading`
     capability family.
   - Refactor `apps/worker/src/agent.ts` to remove `ALL_SKILLS_BY_ID` and its
     `TRADING_SKILL` fallback path. Runtime startup receives resolved local
     skills plus verified external registration artifacts. A missing,
     unhealthy, unauthorized, expired, or descriptor-invalid backend removes
     its requested tools from visibility and reports a generic backend state.
   - Implement the visibility predicate described by Capability Foundations
     document 004: requested tool + verified source-ref mapping + enabled
     registration + generic entitlement + current health + backend-declared
     readiness. A skill reference alone must never enable a backend tool.
   - Dependency: task 3. This is the first executable generic deep-integration
     slice and must be green before deleting first-party skill content.

5. **Connect skills.sh installation to the generic deep-integration resolver.**
   - Inspect and modify `apps/worker/src/tools/skills.ts`,
     `packages/domain/src/{skill-resolution,external-skill-provider-http}.ts`,
     and the agent/blueprint skill-reference persistence paths in
     `apps/api/src/routes/{skills,agents,blueprints}.ts` plus
     `packages/db/src/skill-assignment.ts`.
   - Preserve skills.sh as the generic discovery/install mechanism. After an
     external source ref is installed, resolution consults the remote-boundary
     registry. If it is allowlisted and the verified descriptor declares that
     exact ref/revision, attach its opaque instructions and dynamic tool
     registrations. Otherwise it remains an ordinary markdown/workspace skill
     with no backend tools.
   - Do not create a local DB skill revision merely to make a remote tool
     visible. Store an external source reference/revision separately from
     local `{ skillId, skillRevisionId }` assignments, with a migration that
     is destructive/clean because the environment has no active data.
   - Add tests for ordinary external skills, an allowlisted descriptor-backed
     skill, a source ref that is not allowlisted, descriptor/source revision
     mismatch, disabled backend, and two unrelated backends.
   - Dependency: task 4.

6. **Move trading instructions, docs, and registration artifacts into Traderton; then remove Herobids ownership.**
   - In Traderton, create and publish its own skills.sh-compatible `SKILL.md`
     and domain documentation, and have its descriptor bind the canonical
     source ref(s) to its tool registrations. Tool descriptions, examples,
     payload schemas, workflows, risk language, and pricing remain there.
   - Delete `TRADING_SKILL`, `BOT_MANAGEMENT_SKILL`, and
     `RISK_MONITORING_SKILL` from `packages/domain/src/skills.ts`; remove them
     from `SYSTEM_SKILLS`, `SYSTEM_SKILL_SLUGS`, `SKILL_PRESET_MAP`,
     `TOOL_OWNER_OVERRIDES`, `apps/api/src/sync-system-skills.ts` seed output,
     `apps/worker/src/agent.ts` fallbacks, and all tests/fixtures that treat
     them as platform skills.
   - Delete or convert local trading proxy/tool modules only after their
     generic dynamic replacements are proven. In particular audit the modules
     enumerated by the ownership audit: `tools/{trading,bots,account,analytics,
     market-data,price,watch,risk-limits,find-instrument,resolvers}.ts`, the
     old `traderton/` adapters, and platform tool schemas/catalog entries. No
     tool may retain platform-owned trading descriptions or schemas.
   - Remove or relocate platform-owned trading policy/config/presets identified
     in `config/default.yaml`, `config/strategy-presets/`,
     `packages/domain/src/{agent-risk-contract,agent-protocol,trading/*}.ts`,
     and the associated database/API/web paths. Keep only generic agent
     controls and generic backend entitlement/connection references. Because
     there is no data, delete obsolete rows/tables/columns and migrations
     rather than preserve a migration/compatibility period.
   - Move or delete Herobids trading authoring/documentation, including
     `docs/tech/trading/`, `docs/agents/skills/` trading content,
     trading-specific sections of `README.md` and `docs/vision.md`, and
     public web/API copy under `apps/web/src`. The UI may present generic
     external skills/backends but must not market, curate, or describe
     Traderton's trading product.
   - Dependency: tasks 4 and 5 prove that the external skill can operate
     without any of these platform definitions.

7. **Make the boundary enforceable and complete deployment validation.**
   - Add an architecture test/script rejecting imports from Traderton
     implementation packages and rejecting backend-name/domain terms in the
     generic `remote-boundary` modules. Permit only generic contracts and
     signed descriptor artifacts across the boundary.
   - Update `docker-compose*.yaml`, `Dockerfile`, Caddy/Nomad manifests, and
     `.env*.example` files only after the generic registration config exists:
     Herobids receives generic remote-backend endpoint and caller secrets;
     Traderton owns its service, descriptor signing key, and business config.
     Do not perform deployment changes in this plan.
   - In staging, register Traderton exclusively through the same operator
     configuration used for a synthetic second backend. Verify descriptor-key
     pinning, key rotation, expiry, disabled registration, health loss and
     recovery, tool disappearance/reappearance, idempotent retry, and no
     Herobids trading instructions in prompts or public product pages.
   - Dependency: task 6 removes the concrete system skill; this is the
     release/cutover gate.

## Test Strategy

1. **Unit:** Zod contracts, descriptor signature/pinning/expiry, source-ref
   matching, registry purity, generic HMAC signing, descriptor cache, dynamic
   proxy payload transparency, and the visibility predicate.
2. **Database/API integration:** external ref persistence/resolution versus
   local skill revisions; disabled/unhealthy/unentitled backend responses;
   generic API dispatch; and full deletion of system-skill seed behavior.
3. **Cross-repository contract:** run the same generic invocation, status,
   health, and descriptor conformance suite against Traderton. Include an
   arbitrary non-Traderton fixture to detect special casing.
4. **Worker integration:** install an ordinary skills.sh skill and a
   descriptor-backed skill; only the latter receives proxy tools. Test
   deadline/retry/idempotency and health-driven tool visibility.
5. **Static checks:** fail if platform core imports Traderton implementation,
   if generic boundary files contain domain policy identifiers, or if a
   backend-owned tool is still a static Herobids tool/schema/skill seed.
6. **Staging/manual:** inspect resolved prompts, skill catalogue, agent tool
   visibility, public navigation, SEO/sitemap, and billing/product wording;
   exercise backend restart and signer rotation. Finish with targeted suites,
   `pnpm lint`, and both repository test gates.

## Staging And Cutover

1. Add Traderton as an operator registration on staging only after the generic
   protocol and its tests are green. Use a real remote service URL and secret
   references, never a hard-coded `traderton` code path.
2. Verify a deliberately disabled registration and an invalid descriptor are
   fail-closed before enabling the valid registration. No requested backend
   tool may reach the model or dispatch path while its registration is invalid.
3. With no active deployment/data, do not dual-run old and new skills, migrate
   legacy agents, or retain compatibility aliases. Cut over by removing the
   system seeds and old client/tool modules in the same release that enables
   the verified registration.
4. Rollback is deployment/configuration rollback to the prior Herobids build,
   not a retained dual implementation in the target codebase.

## Open Decisions Requiring User Or Legal Input

1. Confirm the canonical Traderton skills.sh publisher/repository refs,
   immutable revision policy, and whether the stable opaque `backendId` is the
   vendor identity or a product-neutral deployment identifier. These are trust
   and supply-chain identifiers, not implementation details.
2. Approve the legal product boundary: which Herobids UI/API pages, SEO text,
   marketplace search results, billing links, and setup/connection flows may
   mention or link to a third-party trading skill, and which must be removed.
   The current README, vision, navigation, agent presets, and locale copy all
   contain trading product language.
3. Confirm the control-plane authorization contract for arbitrary paid remote
   skills: whether Herobids sends only a generic signed entitlement assertion,
   or whether billing/entitlement is wholly backend-managed. Herobids must not
   embed Traderton pricing or policy either way.
4. Approve the descriptor key-custody and rotation authority: operator-managed
   public-key pins, backend-owned signing keys, cache lifetime, and emergency
   revocation procedure.
5. Decide the disposition of the currently platform-owned market-assessment,
   approval, and generic-agent controls that carry trading terminology. The
   audit identifies these as deliberate platform surfaces, but legal review
   must decide whether they are neutral generic orchestration, move to
   Traderton, or are removed before the product-boundary claim is made.