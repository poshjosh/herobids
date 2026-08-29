# Agent Message Document Handling

**Status:** draft  
**Created:** 2026-08-29  
**Parent roadmap:** [Pending Program Master Roadmap](../000-program/001-master-roadmap.md)

## Purpose

Decompose inbound document handling into ordered slices so the platform can fix
silent attachment drops, establish generic storage and runtime contracts, add
multimodal support safely, and then polish user-facing attachment flows.

## Scope

This roadmap includes:

1. inbound attachment ingestion and durable storage for agent-facing messages
2. runtime document access and text-fallback behavior for non-vision paths
3. multimodal conversation and provider-contract changes where needed
4. later UI and authoring polish such as agent-form attachments

This roadmap does not include:

1. arbitrary binary payload generation by the agent runtime
2. Telegram-only ad hoc handling that cannot generalize to other channels
3. skipping storage, security, or size controls in order to reach multimodal
   support faster
4. product-code implementation in this documentation step

## Non-Goals

1. Do not continue silently dropping non-text inbound attachments.
2. Do not require full multimodal provider support before landing the first
   usable text-fallback slice.
3. Do not let agent-form attachment work pre-empt the message-ingestion path.
4. Do not widen this feature into outbound attachments, which remain a separate
   dependent feature.

## Dependencies

1. [Pending Program Master Roadmap](../000-program/001-master-roadmap.md)
   places this feature after chat sessions and LLM cost attribution, and before
   outbound attachments.
2. [Pending Feature Inventory](../000-program/005-feature-inventory.md)
   requires this feature to use a canonical `001-roadmap.md` with ordered child
   docs.
3. [000-notes.md](./000-notes.md) remains the legacy source for current text-only
   limitations, phased recommendation, and risk inventory.
4. This feature inherits the master-roadmap requirement that outbound
   attachment delivery layers on the stored-document model defined here rather
   than inventing a parallel capability track.

## Fixed Decisions

1. The first slice must stop silent drops by establishing a real inbound
   attachment path and durable storage contract.
2. The document envelope and runtime path must stay generic enough to support
   Telegram, direct chat, and later channels.
3. Non-vision and cost-sensitive paths require an explicit text fallback even
   after multimodal support exists.
4. File type, size, storage, and security controls are part of the feature's
   contract, not optional polish.
5. Agent-form attachments are later polish on top of the same stored-document
   model rather than a separate ingestion path.

## Open Latitude

Implementation may choose the following without escalation, as long as the
fixed decisions, dependencies, acceptance criteria, and validation still hold:

1. exact document storage location and cleanup policy, as long as ownership and
   runtime access remain explicit
2. exact attachment metadata shape carried through envelopes and runtime state
3. whether PDF handling starts with text extraction, image rendering, or a
   bounded hybrid path, as long as the fallback and cost boundaries stay clear

## Child Docs And Sequence

Executable child docs to create in C09:

1. `002-inbound-document-ingestion-and-storage.md`
2. `003-runtime-document-access-and-text-fallback.md`
3. `004-multimodal-conversation-and-provider-contracts.md`
4. `005-ui-and-agent-authoring-polish.md`

Supporting task lists should start only after the first child doc fixes the
inbound storage contract and the second child doc fixes runtime fallback rules.

## Acceptance Criteria

1. The roadmap fixes the feature-wide order from ingestion through runtime,
   multimodal support, and UI polish.
2. The feature boundaries keep outbound attachments, arbitrary binary
   generation, and channel-specific hacks out of scope.
3. Later C09 and C10 work can decompose the feature without guessing whether
   the first executable slice requires full vision support.
4. The roadmap stays aligned with the later outbound-attachments dependency.

## Validation

1. Compared the child-doc sequence and fixed decisions against
   [000-notes.md](./000-notes.md).
2. Confirmed the dependency position and canonical shape against
   [../000-program/001-master-roadmap.md](../000-program/001-master-roadmap.md)
   and [../000-program/005-feature-inventory.md](../000-program/005-feature-inventory.md).
3. Verified that the required section order matches
   [../000-program/002-feature-doc-template.md](../000-program/002-feature-doc-template.md).
