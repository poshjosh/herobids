# Native Capability Activation And External Backend State Model

**Status:** draft
**Created:** 2026-07-18  
**Parent roadmap:** [Capability Implementation Roadmap](./001-roadmap.md)  
**Prerequisite:** [Initial Capability Registry And Tool Ownership Manifest](./009-initial-capability-registry-and-tool-ownership-manifest.md)

## Purpose

Define the durable, authoritative state that activates a native capability for
an agent and the separate resolved state that makes an external backend
dispatchable. Native capability activation is distinct from resolved skills,
runtime-family compatibility data, backend readiness, and `capabilityMode`.

## Scope

This doc includes:

1. the authoritative activation state and persistence model for native
   capabilities
2. the API write lifecycle, migration rules, resolver inputs, and runtime
   propagation behavior for native activation
3. the generic registration and dispatchability model for external backends
4. the explicit predicates for `messaging`, `send_message`, `send_email`, and
   external trading tools

This doc does not include:

1. shared control-plane taxonomy design
2. external-backend transport or extraction mechanics
3. public route compatibility policy outside activation and state endpoints

## Non-Goals

1. Do not infer native activation from `capabilityMode`, connections, bots, or
   past trades.
2. Do not create or rely on an agent capability activation row for an external
   backend.
3. Do not let resolved skills alone activate a native capability or dispatch an
   external backend.
4. Do not collapse provider readiness or backend health into activation state.

## Dependencies

1. [Capability Implementation Roadmap](./001-roadmap.md) keeps this doc as an
   active supporting reference for control-plane resolution, worker visibility,
   and messaging readiness behavior.
2. [009-initial-capability-registry-and-tool-ownership-manifest.md](./009-initial-capability-registry-and-tool-ownership-manifest.md)
   defines the native capability IDs, backend IDs, and ownership data this
   model uses.
3. [003-capability-resolution-and-route-migration.md](./003-capability-resolution-and-route-migration.md),
   [004-worker-tool-visibility-enforcement.md](./004-worker-tool-visibility-enforcement.md),
   [005-trading-capability-extraction.md](./005-trading-capability-extraction.md),
   and [006-messaging-capability-extraction.md](./006-messaging-capability-extraction.md)
   consume this model directly.

## Fixed Decisions

1. The authoritative native state is the `agent_capability_activations` table.
   It stores native capability IDs only.
2. External backends are not activated through that table. They are
   dispatchable when registration, auth or entitlement, health, and
   backend-declared readiness conditions hold.
3. `UnifiedAgentConfig.capabilityMode` does not read from or write to either
   state model.
4. `messaging` provider actions use explicit native activation, while
   `send_message` and `publish_artifact` retain the documented implicit
   platform-inbox rule.
5. External trading tools do not require a native capability activation row.

## Open Latitude

Implementation may choose the following without escalation, as long as the
fixed decisions, dependencies, acceptance criteria, and validation still hold:

1. exact repository boundaries for activation writes and reload events
2. event payload shape beyond the required identity and version fields
3. test placement across db, API, and worker suites

## Acceptance Criteria

This supporting reference is fit for implementation use only when:

1. the native activation authority, write lifecycle, and resolver predicates
   are explicit and mutually consistent
2. explicit native activation, implicit messaging, and external-backend
   dispatchability are all defined without overlap
3. migration behavior for existing agents is explicit
4. required verification is specific enough to validate later resolution and
   worker-gating phases

## Validation

1. validate the checks listed under `## Required Verification`
2. confirm later phase docs do not infer native activation or backend
   dispatchability from `capabilityMode`, connections, or skills alone
3. keep `pnpm lint` as the final repo-wide validation gate for any touched code

## Authority And Persistence

The authoritative native state is the `agent_capability_activations` table:

```text
agent_id                 UUID, foreign key to agents, not null
capability_id            text, NativeCapabilityId, not null
enabled                  boolean, not null
activation_version       integer, not null
updated_at               timestamptz, not null
updated_by_actor_type    text, not null
updated_by_actor_id      UUID, not null
primary key              (agent_id, capability_id)
```

Only registered native capability IDs may be written. `activation_version`
increments on every state transition and is included in native-capability audit
events so logs identify the activation decision used for a call.

There is no corresponding per-agent activation table for external backends in
this model. External backend state remains a resolved view composed from the
registry, operator config, entitlement inputs, health, and backend-declared
readiness.

`UnifiedAgentConfig.capabilityMode` remains runtime-composition terminology and
must not read from or write to either state model.

## Initial Rules

| Control-plane object | State mode | Active or dispatchable when | Inactive when |
| --- | --- | --- | --- |
| `messaging` | implicit platform-inbox or brokered native messaging | the requested tool is `send_message` or `publish_artifact` and the platform-inbox or brokered native messaging rule applies | the session has no platform-inbox or brokered native messaging surface |
| `messaging` | explicit provider action | the messaging row is enabled and tool-specific provider readiness is satisfied | no enabled row exists or readiness is not satisfied |
| external backend `trading` | registered external backend | backend registration exists, caller has required entitlement or config, backend health is ready, and backend readiness summary is satisfied | any prerequisite is missing |

`send_email` therefore requires both an enabled messaging activation and a
ready email binding. External trading tools do not require a native activation
row and must not infer one.

## API And Write Lifecycle

The API owns native-capability activation writes and exposes:

```text
GET /agents/:agentId/capabilities
PUT /agents/:agentId/capabilities/:capabilityId/activation
```

The PUT body is exactly:

```json
{ "enabled": true }
```

It validates `capabilityId` against the native-capability registry, verifies
the requester owns the agent or has platform-admin authorization, then
transactionally upserts the activation row and writes an audit event. Agent
creation accepts an optional `capabilityIds: NativeCapabilityId[]` field. The
create route writes the corresponding enabled rows in the same transaction as
the agent. Agent update uses the dedicated activation route; it does not
overload skill updates or `capabilityMode`.

Read-only external-backend state surfaces are covered by document 011. There is
no agent-scoped activation write route for external backends in this model.

The native activation response contains the canonical capability ID, `enabled`,
`activationVersion`, `updatedAt`, and a resolver-derived current state. It must
not claim readiness merely because activation succeeded.

## Migration And Existing Agents

The database migration creates the table with no implicit enabled rows and no
external-backend backfill. Trading is external and must not receive native
activation rows.

If compatibility requires a one-time backfill for provider-backed messaging
actions, it must be limited to agents with existing explicit email-delivery
configuration or another explicit native messaging opt-in. It must not infer
activation from a connection alone, `capabilityMode`, a bot, or a past trade.

This keeps future native activation decisions explicit while leaving external
backend access in the external-backend state model.

## Resolver Inputs And Predicate

The effective visibility resolver receives only these inputs:

1. the static native-capability registry and external-backend registry;
2. enabled native activation rows and versions;
3. resolved skills and their requested tools;
4. session mode and platform rules;
5. entitlement and binding summaries;
6. native platform health and backend health; and
7. backend-declared readiness summaries.

For each requested tool:

```text
visible = knownTool
       && requestedByBaselineOrResolvedSkill
       && hasExactlyOneOwner
       && ownerStateSatisfied
       && toolSpecificReadinessSatisfied
       && healthSatisfied
       && notExcludedByRuntimePolicyOrDegradation
```

Where:

```text
ownerStateSatisfied = ownerIsCore
                   || ownerIsGeneral
                   || ownerIsActiveNativeCapability
                   || ownerIsDispatchableExternalBackend
```

For a native capability, `ownerIsActiveNativeCapability` means the durable row
is enabled or an explicitly documented implicit rule applies. For an external
backend, `ownerIsDispatchableExternalBackend` means the backend's generic
registration and readiness inputs are satisfied. A skill alone is insufficient
in either case.

Control-plane state resolution is separate from the effective visibility
resolver above. Native activation and external-backend dispatchability are
resolved before skill-based visibility composition is applied.

## Runtime Propagation And Deactivation

After a successful native activation write, API publishes an agent
capability-change event containing `agentId`, `capabilityId`, and
`activationVersion`. Worker reloads the runtime descriptor and recomputes
visibility before acknowledging the update. New sessions always resolve native
activation directly from the database.

External-backend dispatchability changes when operator config, entitlement or
binding state, or backend health changes. Worker recomputes visibility from the
resolved external-backend state without writing an activation row.

Disabling a native capability or losing external-backend dispatchability:

1. removes the affected tools from subsequent visibility snapshots;
2. rejects new calls that rely on the missing state;
3. does not cancel already persisted side effects or close positions by side
   effect;
4. does not stop reconciliation, delivery recovery, or other safety-critical
   background work; and
5. is idempotent when the requested state already exists.

## Required Verification

Tests must prove that:

1. a trading skill alone cannot expose an `external:trading` tool;
2. an enabled native messaging activation without a requesting skill does not
   expose arbitrary messaging tools;
3. an enabled native activation plus a requesting skill exposes a provider
   action only when the relevant readiness conditions hold;
4. `send_message` remains visible through the implicit messaging rule;
5. an external-backend-owned tool requires backend registration, entitlement,
   health, and readiness, and does not require a native activation row;
6. changing `capabilityMode` does not change native capability activation or
   external-backend dispatchability by itself; and
7. deactivation or degradation propagation removes tools without cancelling
   durable safety work.