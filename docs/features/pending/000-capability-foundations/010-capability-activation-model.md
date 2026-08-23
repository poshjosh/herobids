# Capability Activation Model

**Status:** proposed  
**Created:** 2026-07-18  
**Parent roadmap:** [Capability Implementation Roadmap](./001-roadmap.md)  
**Depends on:** [Initial Capability Registry And Tool Ownership Manifest](./009-initial-capability-registry-and-tool-ownership-manifest.md)

## Purpose

Define the durable, authoritative state that activates a product capability for
an agent. Product capability activation is distinct from a resolved skill,
runtime binding family, connection readiness, and `capabilityMode`.

## Authority And Persistence

The authoritative state is the new `agent_capability_activations` table:

```text
agent_id                 UUID, foreign key to agents, not null
capability_id            text, ProductCapabilityId, not null
enabled                  boolean, not null
activation_version       integer, not null
updated_at               timestamptz, not null
updated_by_actor_type    text, not null
updated_by_actor_id      UUID, not null
primary key              (agent_id, capability_id)
```

Only registered product capability IDs may be written. `activation_version`
increments on every state transition and is included in invocation
authorization assertions so service logs identify the activation decision used
for a call.

`UnifiedAgentConfig.capabilityMode` remains runtime-composition terminology and
must not read from or write to this table.

## Initial Rules

| Capability | Activation mode | Active when | Inactive when |
| --- | --- | --- | --- |
| `crypto-trading` | explicit | the agent's `crypto-trading` activation row is enabled | no row exists or the row is disabled |
| `messaging` | implicit for platform inbox | the requested tool is `send_message` or `publish_artifact` and the platform inbox rule applies | the session has no brokered platform messaging surface |
| `messaging` | explicit provider action | the messaging row is enabled and tool-specific provider readiness is satisfied | no enabled row or readiness is not satisfied |

`send_email` therefore requires both an enabled messaging activation and a ready
email binding. `send_message` does not require an email connection and remains
available through the explicitly documented implicit platform-inbox rule.

## API And Write Lifecycle

The API owns user authorization and exposes:

```text
GET /agents/:agentId/capabilities
PUT /agents/:agentId/capabilities/:capabilityId/activation
```

The PUT body is exactly:

```json
{ "enabled": true }
```

It validates `capabilityId` against the shared registry, verifies the requester
owns the agent or has the platform-admin authorization, then transactionally
upserts the activation row and writes an audit event. Agent creation accepts an
optional `capabilityIds: ProductCapabilityId[]` field. The create route writes
the corresponding enabled rows in the same transaction as the agent. Agent
update uses the dedicated activation route; it does not overload skill updates
or `capabilityMode`.

The activation response contains the canonical capability ID, `enabled`,
`activationVersion`, `updatedAt`, and a resolver-derived current state. It must
not claim readiness merely because activation succeeded.

## Migration And Existing Agents

The database migration creates the table with no implicit enabled rows. A
follow-up data migration enables `crypto-trading` only for an existing agent
whose assigned skill revision declares runtime binding family `trading`. The
migration writes `updated_by_actor_type: 'system'` and an audit record. It does
not infer activation from a connection alone, `capabilityMode`, a bot, or a
past trade.

This preserves the intent of existing trading-skill agents while making all
future activation decisions explicit. Agents without such a skill begin with
crypto trading inactive.

## Resolver Inputs And Predicate

The shared resolver receives only these inputs:

1. the static registry and ownership manifest;
2. enabled activation rows and versions;
3. resolved skills and their requested tools;
4. session mode and platform rules;
5. runtime binding readiness/defaults; and
6. capability-service health.

For each requested tool:

```text
visible = knownTool
       && requestedByBaselineOrResolvedSkill
       && hasExactlyOneOwner
       && ownerIsCoreOrGeneralOrCapabilityActive
       && toolSpecificReadinessSatisfied
       && serviceHealthyWhenCapabilityOwned
       && notExcludedByRuntimePolicyOrDegradation
```

For an explicit capability, `CapabilityActive` means the durable row is enabled.
A skill that requests a trading tool without that row is insufficient. An
enabled capability with no skill requesting a tool does not make arbitrary
tools visible. This is the required two-key model.

## Runtime Propagation And Deactivation

After a successful activation write, API publishes an agent capability-change
event containing `agentId`, `capabilityId`, and `activationVersion`. Worker
reloads the runtime descriptor and recomputes visibility before acknowledging
the update. New sessions always resolve activation directly from the database.

Disabling a capability:

1. removes its tools from subsequent visibility snapshots;
2. rejects new invocation requests with `precondition.capability_inactive`;
3. does not cancel already persisted side effects or close trading positions;
4. does not stop reconciliation, delivery recovery, or other safety-critical
   capability background work; and
5. is idempotent when the requested state already exists.

## Required Verification

Tests must prove that:

1. a trading skill alone cannot expose a trading-owned tool;
2. an enabled crypto-trading activation without a requesting skill does not
   expose a trading tool;
3. an enabled activation plus a requesting skill exposes the tool only when
   the relevant readiness and service-health conditions hold;
4. `send_message` remains visible through the implicit messaging rule;
5. `send_email` requires explicit messaging activation and ready email binding;
6. changing `capabilityMode` does not change product capability activation; and
7. disable propagation removes tools without cancelling durable safety work.