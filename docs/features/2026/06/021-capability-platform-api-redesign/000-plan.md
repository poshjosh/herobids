# 021 — Capability Platform API Redesign

**Status:** `in progress`

**Depends on:**

- [Feature Roadmap](../000-roadmap.md)
- [Implementation Guide](../008-agent-platform-roadmap/000a-how-to-implement.md)
- [Capability API Redesign Q&A](../002-capability-api-redesign-q-and-a.md)
- [Capability Platform API Architecture](../021-capability-platform-api-architecture.md)

## Progress

| Step | Description | Status |
|---|---|---|
| 21.1 | Introduce platform primitives: connections, grants, shared readiness/event contracts | `done` |
| 21.2 | Redesign capability-family API namespace and agent-scoped capability routes | `done` |
| 21.3 | Reframe trading resources onto capability bindings and optional bots | `done` |
| 21.4 | Rework worker/runtime composition around skills, bindings, context providers, and prompt renderers | `not started` |
| 21.5 | Rework frontend navigation and primary pages to be agent-first rather than trading-first | `not started` |
| 21.6 | Replace old tests with capability-model integration and UAT coverage | `not started` |

## Goal

Reshape Herobids from a trading-first API and UI into an agent-first platform whose capabilities are extended through skills, explicit grants, and capability-specific bindings.

The redesign must preserve strong trading semantics internally while making trading only one capability family among many.

## Context

The current system already contains platform-level concepts such as agents, skills, AI endpoints, datasets, analytics, billing, and admin, but the API and frontend still lean heavily toward trading-first nouns and flows. The settled redesign decisions are recorded in:

- [Capability API Redesign Q&A](../002-capability-api-redesign-q-and-a.md)
- [Capability Platform API Architecture](../021-capability-platform-api-architecture.md)

The key architectural decisions already made are:

1. One unified public API, organized by bounded domains.
2. Agents are the primary product surface and primary execution actor.
3. Skills are the gateway to capability families.
4. Credentials and connections are shared platform resources.
5. Capability families live under `/capabilities/:family/...`.
6. Agent-scoped capability routes are the primary operational surface.
7. Capability bindings are family-specific execution targets derived from connections.
8. Shared readiness, shared event envelopes, and shared revocation semantics apply across all families.
9. Bots remain optional trading-specific managed artifacts, not platform primitives.
10. No backward compatibility is required for the redesign.

## Deliverables

### 1. Platform primitives

Introduce or normalize the following platform concepts across API, worker, and frontend:

- `credentials`
- `connections`
- capability-scoped `grants`
- shared readiness contract
- shared event envelope

These concepts must be capability-agnostic and reusable across trading and future capability families.

### 2. Capability namespace

Define and implement the new route shape:

```text
/capabilities/:family/...
/agents/:agentId/capabilities/:family/...
```

Rules:

- family-level routes expose catalogs, bindings, and shared configuration
- agent-scoped routes expose state, readiness, activity, outcomes, and explicit action endpoints
- reads are resource-oriented
- execution uses explicit action routes

### 3. Trading reframing

Reframe current trading-specific constructs into the capability model:

- current credentials become platform credentials
- current venue accounts evolve toward trading bindings derived from connections
- current bots remain optional advanced trading constructs
- public trading surfaces become agent-oriented first, with infrastructure nouns moved to advanced surfaces or secondary routes

### 4. Runtime composition

Refactor the runtime composition model so that:

- skills declare capability families, required context blocks, and binding requirements
- dedicated context providers build typed context blocks
- prompt renderers present context appropriately, including provider-specific wording where useful
- policy enforcement is split between platform-level constraints and capability-family extensions

### 5. Frontend redesign

Rework the primary UX to center on:

- agents
- skills
- connections
- credentials
- billing
- activity
- outcomes

Secondary or advanced surfaces may expose capability bindings, provider diagnostics, and lower-level infrastructure.

### 6. Testing model

Replace trading-first endpoint assumptions in tests with capability-model coverage.

Testing must include:

- API integration tests for new platform and capability routes
- agent-scoped capability route coverage
- grant and readiness lifecycle tests
- event envelope tests
- UAT coverage for the primary agent-first flows

## Plan

### 21.1 Platform primitives

Define the canonical types, schemas, persistence model, and API contracts for:

- credentials
- connections
- grants
- readiness
- event envelope

Subtasks:

- identify what current tables can be reused versus replaced
- decide the minimum initial connection schema needed for the hard cut
- define capability-family binding provenance back to connection and credential
- define append-only audit semantics for grants and binding-state changes

### 21.2 Capability routes

Implement the canonical route layout described in the architecture doc.

Subtasks:

- add `/capabilities/:family/...` route registration model
- add `/agents/:agentId/capabilities/:family/...` route registration model
- remove trading-first route assumptions where they conflict with the new model
- ensure explicit action endpoints exist for mutating operations

### 21.3 Trading as one capability family

Migrate trading to the new model first as the proving capability family.

Subtasks:

- map `venue_accounts` to trading bindings
- preserve explicit trading semantics internally
- keep bots optional and clearly secondary to direct agent capability use
- move public trading entry points toward agent-centric state, outcomes, and actions

### 21.4 Runtime refactor

Refactor runtime wiring so the core runtime orchestrates rather than owning family-specific logic.

Subtasks:

- make skills declare required capability families and binding requirements
- add context-provider composition around capability families
- add prompt-renderer composition over typed context
- integrate readiness and eligibility into runtime decision-making

### 21.5 Frontend refactor

Rework routing, navigation, and page grouping around the new architecture.

Subtasks:

- remove trading-first navigation as the default product shape
- surface connections and credentials as platform resources
- move capability-family infrastructure views behind progressive disclosure
- ensure mission-control and agent flows operate cleanly without bot-first assumptions

### 21.6 Test replacement

Add new tests for the redesign and delete or replace tests whose assumptions are no longer valid.

Subtasks:

- API integration coverage for connections, grants, readiness, and capability actions
- family-level and agent-scoped route coverage
- websocket and event-envelope coverage under the shared event model
- UAT flows for agent creation, capability enablement, connection grant, readiness, and execution

## Explicitly Rejected

- Backward compatibility routes, aliases, or migration shims
- A second top-level roadmap for this redesign
- A cloned implementation-guide document for this redesign

The existing shared roadmap and implementation guide remain the source of process truth.

## Exit Criteria

- [ ] Shared platform primitives (`credentials`, `connections`, grants, readiness, events) exist in code and are used consistently
- [ ] Capability family namespace and agent-scoped capability routes replace trading-first route assumptions
- [ ] Trading works as a capability family under the new model
- [ ] Bots remain optional advanced trading constructs rather than required platform primitives
- [ ] Frontend primary navigation and core pages are agent-first
- [ ] Integration tests cover the new route model and lifecycle semantics
- [ ] UAT covers primary agent-first capability enablement and execution flows
- [ ] `pnpm lint` passes

## Decision Log

| Date | Decision | Reason |
|---|---|---|
| 2026-06-07 | Use the existing [Feature Roadmap](../000-roadmap.md) and existing [Implementation Guide](../008-agent-platform-roadmap/000a-how-to-implement.md) rather than creating new meta docs for this redesign | The redesign is a new feature plan within the current process, not a separate planning framework |
| 2026-06-07 | Public noun for capability-scoped access tokens is **bindings** (not grants) | "Grants" is an internal mechanism; "bindings" is the user-facing term that reflects the capability-specific execution target |
| 2026-06-07 | Aggregate readiness lives in `capabilities/index.ts` not `capabilities/trading.ts` | It spans all families by definition; trading.ts only knows about its own family |
| 2026-06-07 | Trading action names: `start`, `stop`, `pause`, `resume`, `bind`, `unbind` | Lifecycle actions map to agent state transitions; bind/unbind map to grant create/revoke |
| 2026-06-07 | `start`/`stop`/`pause`/`resume` in trading capability are honest wrappers around agent lifecycle | Per Step 21.2 plan — the agent is the product surface; the capability route owns the UX entry point |
| 2026-06-07 | No backward compatibility is required at API, UI, or schema level | The project is not yet live, so redesign complexity should not be increased by transitional shims |
| 2026-06-07 | Step 21.1: `user_credentials` table reused as-is for platform credentials — already capability-agnostic | Existing table already fits the platform credential role; no schema changes required |
| 2026-06-07 | Step 21.1: `agent_credentials` table left in place — will be superseded by `capability_grants` once step 21.3 completes the trading reframe | Removing it now would break existing trading flows before the replacement is wired |
| 2026-06-07 | Step 21.1: `connections` table uses a nullable `credential_id` — allows OAuth-based connections without a raw-secret credential | Not all providers require secrets; the FK is optional per the architecture |
| 2026-06-07 | Step 21.1: Unique constraint `uq_capability_grants_active` on (agentId, connectionId, capabilityFamily) — prevents duplicate active grants for the same tuple | Revoked rows are retained for audit, so the unique constraint is on the full tuple, not just active ones; re-granting the same connection+family replaces via revoke+new insert |
| 2026-06-07 | Step 21.1 (second pass): `grant-service.ts` centralizes all grant state transitions so audit rows are always written on state changes — routes never mutate grants directly | Enforces append-only audit semantics at the service boundary |
| 2026-06-07 | Step 21.1 (second pass): `readiness.ts` exposes both `/agents/:id/capabilities/:family/readiness` (family-level) and `/agents/:id/capabilities/readiness` (all-families aggregate) — matches the architecture spec | Covers both targeted checks and mission-control overview use cases |
| 2026-06-07 | Step 21.1 (second pass): `UserEventPublisher` now wraps every event in `PlatformEventEnvelope` before publishing to Redis — the WebSocket transport forwards the envelope unchanged | Single canonical shape across all capability families; old raw-event shape is embedded inside the payload field |
| 2026-06-07 | Step 21.1 (second pass): Connections exposed under `/connections` (list, create, get, revoke); grants under `/agents/:id/grants` (CRUD + audit) — wired into `apps/api/src/index.ts` | Matches the route map in 021-capability-platform-api-architecture.md |
| 2026-06-07 | Step 21.1 (second pass): Sidebar restructured — Connections and Credentials moved to primary Manage group; Bots and Venues demoted to an Advanced group | Connections are the new platform primitive; trading-specific infrastructure nodes should not dominate the primary nav |
| 2026-06-07 | Step 21.3: initial trading bindings are one-per-connection and are reused across agent grants; multiple bindings per connection are deferred until a provider actually needs them | Keeps the first migration concrete while preserving the capability-binding model |
| 2026-06-07 | Step 21.3: default trading binding is derived deterministically from the newest active grant for the agent/family pair | Avoids adding another mutable default-binding column before the model stabilizes |