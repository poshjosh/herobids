# ADR 002: Capability Model And Registry

**Date:** 2026-07-17
**Status:** Superseded
**Superseded by:** [ADR 008](../08/008-native-capabilities-and-external-backends.md)

This ADR is superseded by ADR 008. It assumed `trading` and `messaging` were
both first-class native platform capabilities with platform-owned service
boundaries. The platform now distinguishes native capabilities from external
backends, and `trading` is no longer the canonical example of a native
capability.

## Context

OpenAIdom is no longer only a trading product. The platform direction is an
agents-as-a-service model where multiple isolated capabilities can coexist as
separate deployable services, starting with trading and messaging.

The current codebase uses the word `capability` for several different things:

1. product-facing domains such as the API capability routes under
   `apps/api/src/routes/capabilities/`
2. runtime binding families derived from provider metadata in
   `packages/domain/src/provider-catalog.ts`
3. skill metadata field names such as `capabilityFamilies` in
   `packages/domain/src/skills.ts`
4. per-tool sandbox grant keys in
   `apps/worker/src/agents/capability-policy.ts`
5. runtime-composition config fields such as `capabilityMode` in
   `packages/domain/src/config/schema.ts`

That overload is tolerable while trading is the dominant product surface, but
it becomes a source of design drift once messaging, chat sessions, documents,
marketplace assets, and future capabilities are added.

We need one simple model for product taxonomy that:

1. cleanly distinguishes product domains from infrastructure details
2. supports multiple providers under a single user-facing capability
3. allows different families inside a capability without inventing a new model
4. does not force current implementation details to masquerade as product truth

## Decision

### 1. Product taxonomy uses three levels

The canonical product taxonomy is:

`capability -> family -> provider`

Definitions:

- **Capability**: a separately deployable isolated product or service domain
   boundary
- **Family**: a capability-specific grouping of providers that share a common
  interaction shape or contract
- **Provider**: the concrete integration behind that family

In this model, a capability is not just a logical product grouping. A declared
product capability is expected to own its own deployable service boundary, even
when product metadata for that capability is described centrally in the shared
registry.

The word **family** is intentionally capability-agnostic. It works for
messaging and trading without introducing separate naming schemes such as
"delivery family" for one capability and something else for another.

### 2. First product capabilities

The first product capabilities are:

1. `trading`
2. `messaging`

Both are first-class isolated capabilities and therefore must be implemented as
separate deployable services rather than as in-process feature slices inside
Agent Core.

### 3. Messaging capability model

The messaging capability uses this simple model:

```text
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

Interpretation:

- `messaging` is the product capability
- `email`, `chat`, and `inbox` are messaging families
- `gmail`, `yahoo`, `telegram`, `whatsapp`, and `platform` are providers

This is the product model even when implementation details are transitional.

### 4. Trading uses the same shared model

Trading follows the same structure:

```text
trading
  swap
    jupiter
    1inch
  orderbook
    hyperliquid
    bybit
```

This is the primary reason to prefer the middle term **family**. It remains
usable across capabilities.

The shared platform vocabulary stops here. Deeper trading-domain terms such as
`crypto`, `forex`, and `commodities` belong to the trading boundary rather than
the shared platform taxonomy.

### 5. Runtime binding families remain separate from product taxonomy

Runtime binding families are an implementation layer, not the product model.

Examples from current code:

- `trading`
- `email`

They continue to exist for connection readiness, default binding selection, and
runtime grant resolution.

They are **not** the same thing as product capabilities or product families.

This means:

1. `messaging` may exist as a product capability even when only `email` exists
   as a runtime binding family
2. `chat` and `inbox` can exist in the product model before they become
   connection-backed runtime binding families
3. the registry may describe future providers without pretending that every
   provider already has the same runtime binding semantics
4. `trading` may exist as the product capability while the current
   runtime binding family remains `trading` for compatibility with the existing
   implementation

### 6. Current implementation asymmetry is real and should stay explicit

Current verified behavior is asymmetric:

1. Gmail is a user-linked provider surfaced through provider metadata and
   connection flows
2. Telegram is currently a brokered delivery path plus a Telegram chat ID,
   not a provider connection modeled the same way as Gmail
3. Platform inbox or feed delivery is platform-owned, not an external provider

The product taxonomy should stay simple anyway, but the implementation must not
lie about this asymmetry.

Therefore:

1. the registry may list `telegram` under `messaging/chat`
2. the runtime may still treat Telegram as a brokered transport rather than a
   connection-backed provider until the platform introduces a real user-owned
   chat connection model
3. the registry may list `platform` under `messaging/inbox` even though it is
   an internal provider

### 7. Skills, presets, blueprints, and tools are separate concepts

This ADR does not redefine the rest of the product model:

- a **skill** is reusable expertise and tool access
- a **preset** or **role** is a user-facing bundle of skills
- a **blueprint** is a reusable template entity
- a **tool** is an operation exposed to the agent

Examples:

1. `personal-assistant` is a preset or role, not a capability
2. `send_message` and `send_email` are messaging tools, not capabilities
3. `gmail` is a provider under the messaging capability, not a capability by
   itself

### 8. Registry location

The capability registry should live in shared domain code, not in a database
table.

The registry is static product metadata and should be defined close to shared
provider metadata in a shared domain package consumed across service
boundaries. A code-first registry is sufficient for the current stage and
avoids schema churn.

## Consequences

### Positive

1. The platform gets one simple product taxonomy that can grow beyond the
   current crypto-specific implementation.
2. Messaging no longer has to choose between `email` and `telegram` as the
   top-level concept; both sit under `messaging`.
3. The same model works for trading and messaging.
4. Future providers can be added without redefining the product hierarchy.
5. Product language becomes easier to align across docs, UI, API, and planning.

### Negative

1. The term `capability` remains overloaded in existing code until follow-up
   cleanup is done.
2. The product model will temporarily be cleaner than some of the runtime code.
3. Some current field names such as `capabilityFamilies` and `capabilityMode`
   will remain legacy terminology for a while.

## Follow-Up Rules

1. New product docs must use `capability -> family -> provider` language.
2. Product capability language must treat a capability as a separately
   deployable isolated service boundary, not just a conceptual grouping.
3. New design work must not use `email` as the long-term top-level capability.
4. Runtime binding families must be documented as an implementation layer,
   separate from product capability taxonomy.
5. Telegram must not be forced into the same connection model as Gmail until a
   real user-owned chat provider model exists.
6. Presets and roles must not be described as capabilities.
7. Canonical public capability route IDs must use product capability IDs.
   Runtime binding-family names may appear only as explicit legacy aliases.
8. Trading-specific sub-taxonomy belongs in trading-owned docs or contracts,
   not in the shared platform domain language by default.

## Explicit Non-Goals

This ADR does not:

1. rename existing persisted fields such as `capabilityFamilies`
2. rename `capabilityMode` in unified agent config
3. convert Telegram into a connection-backed provider immediately
4. define the final messaging runtime architecture
5. define the full blueprint marketplace model

## Notes For The Next ADRs

This ADR establishes the vocabulary needed for subsequent work:

1. agent-core vs capability-services boundary
2. capability registry structure and exposure model
3. trading extraction as the first implemented capability
4. messaging architecture and document handling

The next design steps should build on this taxonomy rather than reopening it.