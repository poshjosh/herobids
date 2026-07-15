# Agent Runtime Boundary And Message Contract

This document is the canonical technical reference for the OpenAIdom agent runtime boundary.

Use this document for decisions about ownership, invariants, isolation, identity semantics, and the meaning of agent-to-instance communication. Companion references live alongside it:

- [Message Catalog](./message-catalog.md)
- [Recovery And Replay](./recovery-and-replay.md)
- [Tool Access And Sandboxing](./tool-access-and-sandboxing.md)
- [Billing Enforcement Semantics](./billing-enforcement-semantics.md)

## Purpose

OpenAIdom treats the agent runtime as an isolated reasoning actor, not as a privileged trading process.

The boundary exists to preserve four properties:

1. deployment stays interchangeable across `EC2`, Docker, `ECS`, or later runtimes
2. the engine remains the sole owner of market execution and durable state mutation
3. untrusted or partially trusted agent behavior stays inside a controlled blast radius
4. frontend and audit surfaces can rely on stable fields instead of inference from internal implementation details

## Scope

This document defines:

- who owns strategic intent, execution, and persistence
- how users, agents, bots, and system actors fit into the protocol
- what the agent runtime may and may not do
- which invariants the trading instance may enforce without violating agent purity
- what properties the message contract must preserve regardless of deployment topology

This document does not define:

- orchestrator-specific infrastructure wiring
- a generalized tool protocol for every future platform service
- human approval workflows

Billing enforcement semantics are defined in [Billing Enforcement Semantics](./billing-enforcement-semantics.md), which extends the Agent Mode Purity rules for spending caps.

## Core Terms

### User

The human owner of one or more agents, bots, and trading instances.

### Agent runtime

An isolated process or container that reads approved context, may call approved tools, and may submit decision proposals for one or more trading sessions.

### Bot

A non-isolated execution or strategy actor that may also originate intent, but does not imply the agent sandbox or agent capability model.

### Initiator

The logical author of an action or decision. An initiator may be an `agent`, `bot`, `user`, or `system`. The protocol must not assume that every action originates from an agent runtime.

### Trading instance

The authoritative runtime for one configured trading session. It owns planning, risk checks, execution, reconciliation, journaling, and persistence.

### Strategic intent

The initiator's proposed target-state outcome. In trading terms, this is the desired final exposure, not a venue-specific order instruction.

### `targetSize`

The desired final absolute position size for the instrument after the engine applies planning against current state. It is not the size of the next order by itself.

### Explicit safety invariant

A platform rule that may block or constrain trading because proceeding would be unsafe, unauthorized, unreconciled, or malformed. Examples include invalid schema, unauthorized instance access, unresolved state drift, hard exposure limits, or venue mode mismatches.

### Agent guardrail

An orchestration or product-level control around the agent runtime such as tool allowlists, CPU or time budgets, pause state, or outbound request limits. Agent guardrails do not replace the engine risk gate.

## Ownership Boundary

| Concern | Agent runtime | Trading instance | Worker or platform |
|---|---|---|---|
| Read decision context | yes | yes | yes |
| Apply strategy logic | yes | no | no |
| Submit strategic intent | yes | accepts or rejects | brokers transport |
| Convert intent to plan | no | yes | no |
| Risk enforcement | no | yes | no |
| Venue API execution | no | yes | no |
| Reconciliation | no | yes | no |
| Journal and durable writes | no | yes | platform storage only through instance-owned paths |
| Lifecycle orchestration | **authority over own bots** (create, start, stop, delete) | authoritative per instance execution | authoritative for runtime scheduling |
| Tool policy enforcement | receives capability grant | may validate artifacts | authoritative |

The agent runtime may analyze context and propose intent.

The trading instance remains authoritative for every market-affecting step after proposal submission.

## Purity Rule

OpenAIdom preserves agent purity with a narrow interpretation:

1. The initiator owns strategic intent.
2. The platform must not silently inject hidden strategy constraints or rewrite a valid target because of unspoken preferences.
   Constraints explicitly set by the agent creator through configuration, UI, or instructions are part of the policy and may be enforced.
3. The trading instance may still reject or constrain intent when an explicit safety invariant would otherwise be violated.

This means the engine may reject intent that is malformed, unauthorized, stale against required context, inconsistent with reconciled state, or outside explicit safety bounds.

This does not permit the engine to substitute a different discretionary strategy because it prefers another size, another timing choice, or another thesis.

## Agent Mode Purity

When an agent is running, the agent's goal text and any explicit creator-specified constraints are the **source of trading policy**. The platform must not inject hidden constraints the user did not ask for.

### Constraints vs Data

| Category | Examples | Agent mode rule |
|---|---|---|
| **Constraints** (restrict decisions) | Stop-loss %, take-profit %, max simultaneous positions, portfolio stop, position size caps | **Never apply** unless explicitly configured via one of the two paths below |
| **Data** (inform reasoning) | Price, P&L, position state, market context, progress score, fills history | **Always provide** — the agent reasons over it |
| **Operational mechanics** | Execution mode, slippage tolerance, retry logic, schema validation | **Always apply** — these are infrastructure, not trading policy |

The distinction: a constraint mechanically overrides or prevents the agent's decision. Data is input the agent reads and reasons about — it restricts nothing.

### Risk Gate Two-Path Model

Every risk limit applied to an agent runtime follows exactly one of two paths:

| Path | Source | Mutability at runtime | Example |
|------|--------|----------------------|---------| 
| **User-configured** | Explicitly set by the creator in the agent's config (via UI or API) | **Immutable** — the agent cannot weaken or remove it | User sets `dailyLossLimit: 500` → engine enforces a hard $500/day rolling realized-loss cap. User sets `maxDrawdownPct: 15` → engine enforces a 15% peak-to-current equity drawdown cap. |
| **Operator default** | Read from `config.agentRiskDefaults.*` because the user did *not* specify a value | **Agent-mutable** — the agent can read and adjust it via tools, within operator-defined bounds | Default `maxOpenPositions: 10` → agent may raise it up to `agentRiskDefaults.maxOpenPositions` ceiling |

Key invariants:

1. **No hard-coded magic numbers.** Every default must come from operator config (`config/default.yaml → agentRiskDefaults`), never from source code literals.
2. **Transparency.** The agent must be able to read its effective risk limits (both user-configured and defaulted).
3. **User intent is supreme.** If the user explicitly configured a limit, the agent cannot weaken it.
4. **Operator bounds.** Operator config defines a ceiling that neither user nor agent can exceed (the operator default *is* both the initial value and the ceiling for agent self-adjustment).
5. **The engine risk gate still applies to hard safety invariants.** Malformed payloads, unauthorized access, unreconciled state, and user-configured limits are always enforced.

### What this means in practice

1. **Stop-loss and take-profit.** If the user configured them, the engine enforces them as hard limits. If not, the operator default applies but the agent may adjust or disable it (within operator bounds) via the `adjust_risk_limits` tool.

2. **Position count cap.** Comes from operator default when not user-specified. Agent may raise or lower it.

3. **Daily loss.** If the user explicitly set `dailyLossLimit`, it is a hard cap on rolling 24h realized loss. Otherwise the operator default (`dailyMaxLossPct`) applies and the agent can adjust.

4. **Drawdown.** If the user explicitly set `maxDrawdownPct`, it is a hard cap on peak-to-current equity drawdown (percentage). Otherwise the operator default (`maxDrawdownPct`) applies and the agent can adjust. This is a separate control from daily loss — the engine enforces them independently.

5. **Risk config from the bot blueprint is data, not policy.** The agent may read the blueprint's risk fields as context. The engine does not silently enforce them as hard limits over agent decisions.

6. **Bot blueprints vs agent direct trading.** Bots created by the agent inherit the bot-level risk config specified in their blueprint (that IS their creator-specified config). The agent's own direct trading path uses the agent's risk config.

### Agent Lifecycle Authority

An agent has full lifecycle authority over its own bots. It may create, start, stop, reconfigure, and delete bots without requiring user confirmation for each action.

This authority is bounded by three hard constraints only:

1. **Tenancy** — an agent may only act on bots owned by the same user
2. **Execution authority stays with the engine** — the agent cannot bypass the risk gate or directly submit orders to a venue
3. **No raw credentials** — the agent cannot read or exfiltrate venue API keys or private keys

These are institutional trust boundaries, not capability restrictions. A human employee at a trading firm has the same kind of boundary: they can manage their own book freely, but they cannot access other clients' accounts or bypass the firm's risk controls.

## Hard Invariants

1. The trading instance is the sole owner of execution.
2. No direct venue credentials are available inside the agent runtime.
3. No direct database writes originate from agent code.
4. No direct order-entry or cancellation messages exist in the agent contract.
5. One authoritative journal and persistence path exists for decisions, plans, fills, and reconciliation outcomes.
6. Operator config and runtime instance config stay in separate resolution chains.
7. Invalid startup or operator config fails before trading starts; invalid runtime payloads are rejected within the running protocol unless continuing would be unsafe.
8. Users own agents and bots, but `agent`, `bot`, and `user` must remain distinct identities in the protocol and documentation.

## Container Boundary

The runtime boundary must hold regardless of whether the isolated runtime is launched as a local Docker container, an `ECS` task, or another sandboxed worker.

Minimum required properties:

- no host filesystem access beyond an explicitly provisioned scratch area
- no shared process memory with the trading instance or worker
- no operator config blob mounted into the runtime
- no raw venue secrets or decrypted secret material in the runtime environment
- network and data access restricted by approved capability policy
- bounded CPU, memory, wall-clock time, temporary storage, and process count
- explicit kill and cleanup semantics when limits or policy are violated

Implementation details for tools and sandbox policy are defined in [Tool Access And Sandboxing](./tool-access-and-sandboxing.md).

## Message Contract Principles

1. The contract is versioned and deployment-neutral.
2. Messages are correlation-based, not transport-order-based.
3. Delivery is assumed to be at-least-once, so handlers must be duplicate-safe.
4. The only market-affecting v1 proposal is decision submission.
5. Lifecycle requests are advisory; lifecycle authority remains with the platform.
6. Audit artifacts are non-authoritative and never replace the decision payload.
7. The envelope must distinguish current message authorship from original flow provenance, rather than assuming agent identity is always the relevant secondary field.

The normative v1 message definitions live in [Message Catalog](./message-catalog.md).

## Stable Frontend And Audit Consequences

The frontend may depend on the following concepts being stable across implementations:

- initiator identity and initiator type
- optional origin identity and origin type when later system messages still need upstream attribution
- agent rationale summary
- context hash or equivalent context reference
- decision acceptance or rejection
- plan lifecycle status
- execution outcome summary
- guardrail and risk outcomes as separate concepts
- instance health and recovery state

These fields support the agent-first surfaces already identified in the frontend Q and A: overview, activity feed, outcome board, decision detail, and health strip.

## Deployment Neutrality

`EC2`, Docker, and `ECS` are runtime choices under this boundary, not different product models.

- `EC2` may host both worker and agent containers.
- Docker may be the local packaging and isolation primitive.
- `ECS` may become the scheduling and isolation control plane.

None of those choices change who owns intent, who owns execution, or how the message contract behaves.

## Change Discipline

If a future change would give the agent runtime direct venue authority, direct secret access, or direct durable state mutation, treat it as a boundary change and update this document first.