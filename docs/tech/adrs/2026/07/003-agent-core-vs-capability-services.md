# ADR 003: Agent Core Vs Capability Services

**Date:** 2026-07-17
**Status:** Proposed

## Context

ADR 002 established the product taxonomy:

`capability -> family -> provider`

The first product capabilities are `crypto-trading` and `messaging`.

That solves the naming problem, but it does not yet define the implementation
boundary between:

1. the shared runtime machinery that every agent experience should reuse
2. the capability-specific domain logic that should stay isolated

The current platform already contains both kinds of logic:

1. shared runtime concerns such as agent isolation, LLM turns, tool-call
   orchestration, memory, protocol envelopes, and runtime scheduling
2. crypto-trading-specific concerns such as venue readiness, market data, decision
   submission, risk enforcement, reconciliation, and execution
3. messaging-specific concerns such as brokered user messaging, email sending,
   Telegram routing, and delivery tracking

The stable runtime boundary is already clear in
`docs/tech/agents/runtime-boundary-and-message-contract.md`:

1. the agent runtime is an isolated reasoning actor
2. execution and durable market state remain outside the runtime
3. platform-owned guardrails and protocol boundaries stay authoritative

The chat-session design direction also shows the need for a reusable core. A
chat session should reuse the agent runtime, tool loop, and model pipeline
without inheriting crypto-trading-centric behavior.

Without an explicit boundary, the system drifts toward a trading-shaped core,
where new capabilities are forced to fit crypto-trading assumptions or duplicate
runtime machinery.

## Decision

### 1. Separate the platform into Agent Core and Capability Services

The platform is split conceptually into two layers:

1. **Agent Core**
2. **Capability Services**

This is both a logical and deployment boundary for isolated capabilities.

For major product capabilities such as `crypto-trading` and `messaging`, the
platform requires true isolation from the start:

1. each capability runs as a separate deployable service
2. each capability may run as its own Docker service or equivalent isolated
   deployment unit
3. Agent Core does not host capability-specific implementation in-process
4. direct in-process imports across capability boundaries are not allowed

### 2. Agent Core is capability-agnostic

Agent Core is the shared reasoning and runtime layer used across capabilities.

Agent Core owns:

1. agent runtime lifecycle and isolation
2. session orchestration and scheduling
3. LLM dispatch, tool-call loop, and turn accounting
4. prompt assembly from shared context, skills, and capability-provided context
5. skill resolution and tool visibility composition
6. generic memory and workspace behaviors
7. protocol transport, envelopes, activity events, and correlation IDs
8. cost accounting, runtime budgets, and generic guardrail plumbing
9. actor identity, provenance, and audit shape at the runtime boundary

Agent Core must be able to run:

1. a crypto-trading agent
2. a chat-backed session
3. a messaging-focused agent
4. a future non-trading capability

without needing to become trading-specific itself.

### 3. Capability Services own domain logic and domain state

Each capability service owns the logic that is specific to one product
capability.

Capability Services own:

1. capability-specific tools and tool contracts
2. capability-specific state models and persistence rules
3. capability-specific provider and family integrations
4. capability-specific policy, validation, and routing rules
5. capability-specific context builders exposed to Agent Core
6. capability-specific readiness and binding resolution logic
7. capability-specific background processing and side effects

Capability Services may expose tools to Agent Core, but Agent Core does not own
their business meaning.

### 3A. Capability boundaries require separate configuration and private implementation

Each isolated capability must own a separate configuration surface for its
domain-specific behavior.

That means:

1. capability-specific configuration is defined within the capability boundary
2. capability-specific defaults and validation are owned within the capability
   boundary
3. one capability must not embed its configuration model inside another
   capability, Agent Core, or another service

Public contracts at capability boundaries must use explicit request-response
interfaces.

That means:

1. Agent Core may interact with a capability only through published boundary
   contracts that accept a defined request and return a defined response
2. one capability may interact with another capability only through published
   boundary contracts that accept a defined request and return a defined
   response
3. code outside the capability boundary must not access that capability's
   internal modules, internal state, internal configuration, or internal data
   model directly

Multiple capabilities must not share capability-specific implementation code.
Capability-specific implementation code must also not be shared with Agent Core
or other services.

If code genuinely needs to be shared, it must be moved into an explicitly
designated shared package or boundary module approved for cross-capability use.

That shared code must:

1. expose published contracts, DTOs, ports, protocol envelopes, or generic
   runtime utilities intended for reuse
2. not import capability-owned implementation modules
3. not import Agent Core internals
4. not require a dependency on one capability in order to be used by another

Whether shared code is truly generic may still require review judgment, but the
enforceable rule is structural: cross-capability reuse must happen only through
approved shared modules with allowed dependency directions.

For isolated capabilities, the deployment rule is equally strict:

1. each capability owns its own runtime process or service
2. each capability owns its own deploy-time configuration
3. each capability owns its own persistence boundary where durable state is
   required
4. Agent Core and peer capabilities communicate through boundary contracts over
   service boundaries, not direct implementation reuse

### 4. Crypto-trading is a capability service, not part of Agent Core

Crypto-trading-specific behavior must stay outside Agent Core.

The crypto-trading capability service owns:

1. market data interpretation and trading context assembly
2. provider and family mapping for trading providers
3. trading readiness and connection or binding resolution
4. direct-trading tools such as decision submission, instrument lookup,
   analytics, risk inspection, and bot lifecycle tools
5. handoff to the authoritative trading instance for planning and execution
6. trading-specific persistence, journaling, reconciliation, and execution
   state

Agent Core may call crypto-trading tools and render trading context, but it must not
contain market execution logic.

### 5. Messaging is a capability service, not part of Agent Core

Messaging-specific behavior must stay outside Agent Core.

The messaging capability service owns:

1. messaging families and providers under the model established by ADR 002
2. brokered user-message delivery semantics
3. external email sending semantics
4. channel and provider routing
5. delivery tracking and delivery-state persistence
6. future attachment and document handling under the messaging capability

Agent Core may call messaging tools and include messaging context, but it must
not own recipient routing, provider-specific delivery logic, or channel policy.

### 6. Agent Core must not own capability-specific business rules

Agent Core must not become a hidden home for domain policy.

Agent Core must **not** own:

1. venue execution logic
2. venue credential semantics
3. trading risk-gate behavior
4. provider-specific email or chat delivery logic
5. capability-specific persistence schemas
6. capability-specific marketplace semantics
7. capability-specific policy defaults disguised as shared runtime behavior

If a rule exists only because one capability needs it, that rule belongs in the
capability service.

### 7. Capability Services plug into Agent Core through stable contracts

Agent Core should consume capability services through stable shared contracts,
not ad hoc imports scattered across the runtime.

At minimum, a capability service should be able to provide:

1. capability metadata from the shared registry
2. tool definitions and tool handlers
3. context providers for prompt composition
4. readiness and binding-family interpretation where applicable
5. capability-specific API surfaces above the runtime

This keeps Agent Core generic while still allowing capabilities to grow.

### 8. Chat sessions use Agent Core and capabilities, not a separate runtime stack

Chat sessions should reuse Agent Core.

The session is the user-facing product entity; the backing agent runtime is an
implementation detail. Chat-specific behavior should be composed from Agent Core
plus the relevant capabilities and skills, not from a second bespoke runtime.

This means:

1. chat sessions do not justify a new agent runtime architecture
2. chat sessions may use messaging and non-trading capabilities without being
   trading-centric
3. the capability boundary must hold for both long-running agents and chat
   sessions

### 9. Capability Services are deployable isolation boundaries

In this ADR, the word **service** means both an ownership boundary and a
deployment boundary for isolated capabilities.

For `crypto-trading` and `messaging`, this means:

1. each capability is deployed separately from Agent Core
2. each capability is deployed separately from other isolated capabilities
3. interaction happens through published service contracts
4. Docker service separation is an acceptable reference implementation of this
   rule

This ADR therefore does require separate deployable boundaries for isolated
capabilities. It does not require that every minor feature become its own
service, but any domain promoted to an isolated capability must meet this
deployment standard.

## Boundary Table

| Concern | Agent Core | Capability Service | Other authoritative owner |
|---|---|---|---|
| Runtime isolation | yes | no | platform scheduler |
| LLM turn loop | yes | no | no |
| Skill resolution | yes | no | no |
| Generic memory and workspace | yes | no | no |
| Tool exposure composition | yes | contributes | no |
| Capability-specific tool semantics | no | yes | no |
| Trading decision execution | no | handoff only | trading instance |
| Trading reconciliation | no | no | trading instance |
| User-message routing | no | yes | platform-owned messaging path |
| External email sending | no | yes | messaging provider adapter |
| Provider-specific binding readiness | no | yes | no |
| Runtime scheduling | yes | no | worker or platform |
| Durable capability state | no | yes | capability-owned persistence path |

## Consequences

### Positive

1. Trading stops being the accidental shape of the entire platform.
2. Chat sessions and future capabilities can reuse the runtime without inheriting
   trading assumptions.
3. Capability-specific logic becomes easier to isolate, test, deploy, and
   evolve.
4. The platform gets a cleaner path for messaging, documents, and future
   capability growth.
5. Boundary violations become easier to spot during review.

### Negative

1. Some current modules will remain mixed until follow-up refactors separate
   shared runtime concerns from capability-specific concerns.
2. The platform must absorb the operational cost of multiple deployable
   services earlier.
3. The current package structure will not line up perfectly with this boundary
   on day one.
4. Cross-capability integration requires explicit service contracts and
   deployment plumbing from the start.

## Follow-Up Rules

1. New shared runtime code must be capability-agnostic by default.
2. New capability-specific policy or persistence logic must not be added to
   Agent Core.
3. Capability additions must identify:
   - what belongs in Agent Core
   - what belongs in the capability service
   - what remains with another authoritative owner such as the trading instance
4. When a new tool is added, its business meaning belongs to the capability
   service even if the runtime loop that executes it belongs to Agent Core.
5. Each capability must own its own domain-specific configuration surface,
   including its validation and defaults.
6. Direct interactions across capability boundaries must use published
   request-response contracts.
7. Capability-specific implementation code must not be imported directly across
   capability boundaries or into Agent Core.
8. If multiple capabilities appear to need the same implementation code, that
   code must either move into a neutral shared abstraction or remain private to
   one capability. Shared capability-specific implementation is not allowed.
9. Any domain declared to be an isolated capability must be deployed as a
   separate service from Agent Core and from other isolated capabilities.

## Explicit Non-Goals

This ADR does not:

1. define the full capability registry shape
2. force a package-by-package refactor immediately
3. require every platform feature to become its own separate service
4. redefine the trading instance boundary
5. finalize the messaging runtime architecture

## Notes For The Next Steps

This ADR is the architectural gate before implementation work that extracts
crypto-trading as the first explicit capability.

The next implementation-oriented work should:

1. register product capabilities in shared domain code
2. expose crypto-trading through that registry first
3. keep trading-instance authority intact
4. let messaging grow under the same boundary without inheriting crypto-trading logic
5. establish separate deployable service boundaries for `crypto-trading` and
   `messaging`