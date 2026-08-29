# Agent Outbound Message Attachments

**Status:** draft  
**Created:** 2026-08-29  
**Parent roadmap:** [Pending Program Master Roadmap](../000-program/001-master-roadmap.md)
**Normative inputs:** [Agent Message Document Handling](../025-agent-message-document-handling/001-roadmap.md)

## Purpose

Define the outbound-attachment feature so agents can deliver stored documents
through email and Telegram using one broker-controlled attachment pipeline that
builds on the inbound document model rather than inventing a separate file
channel.

## Scope

This doc includes:

1. extending outbound messaging so agents can reference stored document IDs as
   attachments
2. one broker-side attachment-resolution pipeline shared by Telegram and email
3. attachment auditability, ownership checks, and conservative delivery limits

This doc does not include:

1. raw agent-generated binary attachments
2. attachment delivery outside the `send_message` path
3. separate document storage or ownership models from feature 025
4. product-code implementation in this documentation step

## Non-Goals

1. Do not bypass broker-side ownership and delivery validation.
2. Do not make outbound attachments depend on the agent shipping raw bytes over
   the runtime bus.
3. Do not default to extracted companion files when the original stored file is
   the intended user-facing attachment.
4. Do not widen this feature into general-purpose file sharing.

## Dependencies

1. [Pending Program Master Roadmap](../000-program/001-master-roadmap.md)
   places this feature after agent message document handling.
2. [Pending Feature Inventory](../000-program/005-feature-inventory.md)
   requires this feature to stay as one canonical overview.
3. [001-plan.md](./001-plan.md) remains the legacy source for the attachment
   model, broker pipeline, and adapter expectations.
4. This feature depends on the stored-document contract from
   [../025-agent-message-document-handling/001-roadmap.md](../025-agent-message-document-handling/001-roadmap.md).

## Fixed Decisions

1. V1 outbound attachments reference existing stored documents by ID.
2. Telegram and email share one broker-side attachment-resolution pipeline.
3. The broker, not the agent runtime, owns ownership validation and delivery
   gating.
4. Originals are the default attachment form unless a later controlling doc
   explicitly chooses an alternate representation.
5. Attachment count, per-file size, and total payload limits must remain
   conservative and explicit.

## Open Latitude

Implementation may choose the following without escalation, as long as the
fixed decisions, dependencies, acceptance criteria, and validation still hold:

1. exact audit-table shape and per-channel delivery status fields
2. exact adapter behavior for captions, ordering, and partial per-channel
   failure handling
3. exact operator-config source for attachment limits, as long as the limits
   remain enforced centrally

## Acceptance Criteria

1. The feature is explicitly layered on the stored-document model from feature
   025.
2. The attachment contract keeps ownership checks, delivery resolution, and
   auditability platform-controlled.
3. The overview leaves no ambiguity about V1 boundaries around stored files,
   original-file delivery, and delivery limits.
4. Later task-list work can implement outbound attachments without inventing a
   second document pipeline.

## Validation

1. Compared the scope, fixed decisions, and acceptance boundaries against
   [001-plan.md](./001-plan.md).
2. Confirmed the dependency position and canonical shape against
   [../000-program/001-master-roadmap.md](../000-program/001-master-roadmap.md)
   and [../000-program/005-feature-inventory.md](../000-program/005-feature-inventory.md).
3. Verified that the canonical section order matches
   [../000-program/002-feature-doc-template.md](../000-program/002-feature-doc-template.md).
