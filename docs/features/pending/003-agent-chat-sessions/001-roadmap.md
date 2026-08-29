# Agent Chat Sessions

**Status:** draft  
**Created:** 2026-08-29  
**Parent roadmap:** [Pending Program Master Roadmap](../000-program/001-master-roadmap.md)

## Purpose

Decompose chat sessions into ordered slices so the session-first product model,
hidden-agent runtime, event-driven processing, and multi-channel delivery can
be implemented without collapsing chat semantics back into the trading-agent
loop.

## Scope

This roadmap includes:

1. a session-centric data model and hidden backing-agent contract
2. an event-driven runtime with no fixed tick loop
3. session creation, configuration, and dedicated chat UI flows
4. lifecycle, archival, routing, and multi-channel message integration

This roadmap does not include:

1. exposing chat sessions as ordinary trading agents in the default agent list
2. reusing the trading-agent tick cadence as the core chat runtime model
3. a full migration of existing trading-agent message logs into chat sessions
4. product-code implementation in this documentation step

## Non-Goals

1. Do not make the backing agent the user-facing entity.
2. Do not bypass the existing agent infrastructure with a separate LLM and tool
   pipeline.
3. Do not mix trading-agent lifecycle controls into the chat-session UX.
4. Do not hide unresolved billing or skill-availability decisions inside later
   task lists.

## Dependencies

1. [Pending Program Master Roadmap](../000-program/001-master-roadmap.md)
   places this feature after blank-slate agents and before later cost,
   cadence, and document-handling work.
2. [Pending Feature Inventory](../000-program/005-feature-inventory.md)
   requires this feature to use a canonical `001-roadmap.md` because it spans
   multiple major boundaries.
3. [000-notes.md](./000-notes.md) remains the legacy source for the
   session-first model, event-driven runtime, multi-channel routing, and open
   product questions.
4. This feature inherits the master-roadmap requirement that later cadence,
   document, and attachment features must layer on a session-centric chat model
   rather than reopen runtime ownership.

## Fixed Decisions

1. The chat session is the primary product entity; the backing agent is hidden
   runtime infrastructure.
2. Each session owns its mutable config and conversation history.
3. Chat runtime is event-driven and wake-on-message rather than timer-driven.
4. The backing agent should be per-session, not shared across multiple sessions.
5. Existing agent infrastructure for tools, skill resolution, billing, and
   memory is reused rather than rebuilt.

## Open Latitude

Implementation may choose the following without escalation, as long as the
fixed decisions, dependencies, acceptance criteria, and validation still hold:

1. exact route shapes and repository boundaries for session CRUD and message
   reads
2. the exact UI decomposition for sidebar, message list, and settings panels
3. whether certain secondary product questions are resolved in child docs or in
   their first task list, as long as the hidden-agent and session-first
   invariants remain unchanged

## Child Docs And Sequence

Executable child docs to create in C09:

1. `002-session-data-model-and-hidden-agent-contract.md`
2. `003-event-driven-chat-runtime-and-lifecycle.md`
3. `004-chat-session-api-and-creation-flow.md`
4. `005-chat-ui-and-session-management.md`
5. `006-multi-channel-routing-and-billing.md`

Supporting task lists should start only after the child docs resolve the
remaining product questions at the right layer.

## Acceptance Criteria

1. The roadmap fixes the session-first architecture and hidden-agent boundary.
2. The child-doc sequence covers the source notes' major implementation
   surfaces in a stable order.
3. Later cadence and document features can depend on this roadmap without
   guessing whether chat is tick-driven or agent-centric.
4. Later C09 and C10 work can decompose the feature without reopening the core
   entity, runtime, or lifecycle model.

## Validation

1. Compared the fixed decisions and child-doc sequence against
   [000-notes.md](./000-notes.md).
2. Confirmed the dependency position and canonical shape against
   [../000-program/001-master-roadmap.md](../000-program/001-master-roadmap.md)
   and [../000-program/005-feature-inventory.md](../000-program/005-feature-inventory.md).
3. Verified that the required section order matches
   [../000-program/002-feature-doc-template.md](../000-program/002-feature-doc-template.md).
