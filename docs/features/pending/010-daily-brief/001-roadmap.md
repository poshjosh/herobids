# Daily Brief

**Status:** draft  
**Created:** 2026-08-29  
**Parent roadmap:** [Pending Program Master Roadmap](../000-program/001-master-roadmap.md)

## Purpose

Decompose the daily brief feature into ordered slices so data aggregation,
public distribution, onboarding reuse, and quality hardening can be planned
without overstating what the current market-data sources already prove.

## Scope

This roadmap includes:

1. a daily brief data contract that combines macro calendar, trending
   instruments, market regime, and strategy-preset guidance
2. a public brief surface for newsletter-style delivery
3. reuse of the same brief output in agent-setup and chat-adjacent suggestion
   flows
4. later persistence and quality hardening for stable daily output

This roadmap does not include:

1. claiming crypto-native calendar coverage where only macro coverage exists
2. treating point-in-time Redis snapshots as permanent history without an
   explicit persistence layer
3. mandatory LLM-generated commentary in the first slice
4. product-code implementation in this documentation step

## Non-Goals

1. Do not reopen the underlying economic-calendar or strategy-preset-review
   features here.
2. Do not present a heuristic preset recommendation as a proven backtested
   policy.
3. Do not collapse venue or network distinctions out of the trending-instrument
   section.
4. Do not make the public brief depend on private admin-only endpoints.

## Dependencies

1. [Pending Program Master Roadmap](../000-program/001-master-roadmap.md)
   places this feature after Hyperliquid preset tuning, LLM cost attribution,
   and additional trading skills.
2. [Pending Feature Inventory](../000-program/005-feature-inventory.md)
   requires this feature to use a canonical `001-roadmap.md` with ordered child
   docs.
3. [000-analysis.md](./000-analysis.md) remains the legacy source for current
   infrastructure truth, feasibility, caveats, and phased rollout direction.
4. This feature inherits the master-roadmap requirement that the brief only
   ships after recommendation quality, cost attribution, and enough skill-led
   market logic exist to make the output credible.

## Fixed Decisions

1. The brief is an integration feature over existing data sources, not a new
   market-data subsystem.
2. The first recommendation path may use a deterministic heuristic mapping from
   regime to preset; LLM commentary is optional later work.
3. Macro calendar coverage and multi-venue trending data limitations must be
   explicit in later child docs and output semantics.
4. The same core brief data contract should feed both the public page and any
   agent-setup suggestion flow.
5. A stable daily artifact requires explicit persistence or snapshotting rather
   than relying only on expiring Redis keys.

## Open Latitude

Implementation may choose the following without escalation, as long as the
fixed decisions, dependencies, acceptance criteria, and validation still hold:

1. exact endpoint and page naming for the public brief surface
2. exact persistence mechanism and snapshot cadence used once the brief moves
   beyond point-in-time output
3. whether onboarding reuse lands in the first executable slice or immediately
   after the public page, as long as both consume the same core brief contract

## Child Docs And Sequence

Executable child docs to create in C09:

1. `002-daily-brief-data-contract-and-api.md`
2. `003-public-brief-page-and-distribution.md`
3. `004-agent-setup-and-chat-suggestion-reuse.md`
4. `005-persistence-and-source-expansion.md`
5. `006-validation-and-recommendation-review.md`

Supporting task lists should start only after the first child doc fixes the
shared brief contract and source limitations explicitly.

## Acceptance Criteria

1. The roadmap fixes the brief's ordered path from data contract through public
   surface, onboarding reuse, persistence, and validation.
2. The feature-wide decisions preserve the current source limitations instead
   of hiding them behind optimistic output language.
3. Later C09 and C10 work can decompose the feature without guessing how the
   public page, onboarding reuse, and recommendation logic relate.
4. The roadmap stays aligned with the master-roadmap dependency order.

## Validation

1. Compared the child-doc sequence and fixed decisions against
   [000-analysis.md](./000-analysis.md).
2. Confirmed the dependency position and canonical shape against
   [../000-program/001-master-roadmap.md](../000-program/001-master-roadmap.md)
   and [../000-program/005-feature-inventory.md](../000-program/005-feature-inventory.md).
3. Verified that the required section order matches
   [../000-program/002-feature-doc-template.md](../000-program/002-feature-doc-template.md).
