# Pending Feature Inventory

**Status:** complete  
**Created:** 2026-08-29  
**Depends on:** [000-document-tree.md](./000-document-tree.md), [001-master-roadmap.md](./001-master-roadmap.md), [002-feature-doc-template.md](./002-feature-doc-template.md), [004-validation-and-change-control.md](./004-validation-and-change-control.md)

## Purpose

This document defines the canonical feature inventory for the staged pending
program under `docs/features/pending/`.

It fixes three things that were still ambiguous after the master roadmap:

1. which pending entries are active program features versus follow-up or
   backlog material;
2. the exact canonical folder name and title for every feature on the staged
   path;
3. which features should normalize to a single `001-overview.md` versus a
   `001-roadmap.md` with required `002+` child docs.

This inventory is normative for later normalization work. C06 does not rename
or move existing folders.

## Scope

This document includes:

1. every major feature on the active staged path from current state to target
   state;
2. the independent follow-up feature that remains outside the active staged
   path;
3. the current source path for irregular or missing features;
4. the canonical high-level doc shape for each feature.

This document does not include:

1. promoting backlog notes into active program features;
2. renaming current folders during C06;
3. writing the normalized per-feature docs themselves.

## Assignment Rules

1. Existing feature folders that already fit the canonical `NNN-kebab-case-title/`
   pattern keep their current folder name.
2. A new canonical feature ID is assigned only when the current source is
   missing from `docs/features/pending/` or the current folder name is not a
   valid long-term canonical target.
3. Use `001-roadmap.md` with required `002+` child docs only when the feature
   already has explicit phase structure or clearly spans multiple independently
   verifiable slices across major boundaries.
4. Use `001-overview.md` when one high-level doc can bound the feature and the
   rest of the execution surface can stay in `tasks/`.
5. An independent follow-up feature is still a real feature and gets a
   canonical folder assignment, but it is not part of the active staged path.
6. A backlog note is not a feature in this program until a later roadmap change
   promotes it.

## Active Staged Features

| Order | Canonical folder | Canonical title | Current source entrypoint | Canonical high-level doc | `002+` child docs | Why this shape is required |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `000-capability-foundations/` | Capability Foundations | [000-capability-foundations/001-roadmap.md](../000-capability-foundations/001-roadmap.md) | `001-roadmap.md` | required | The feature already has an authoritative roadmap and active ordered child docs. |
| 2 | `001-hyperliquid-perp-preset-tuning/` | Asset-Class-Aware Hyperliquid Perp Preset Tuning | [001-hyperliquid-perp-preset-tuning/001-plan.md](../001-hyperliquid-perp-preset-tuning/001-plan.md) | `001-roadmap.md` | required | The current plan already uses explicit internal phases for segment-aware preset work. |
| 3 | `030-exit-policy-scale-out-trail/` | Exit Policy: Scale-Out and Trail Remainder | [030-exit-policy-scale-out-trail/001-plan.md](../030-exit-policy-scale-out-trail/001-plan.md) | `001-roadmap.md` | required | The current plan decomposes one feature into ordered exit-behavior slices. |
| 4 | `040-advanced-live-limit-order-management/` | Advanced Live Limit Order Management | [040-advanced-live-limit-order-management/001-plan.md](../040-advanced-live-limit-order-management/001-plan.md) | `001-roadmap.md` | required | The feature spans amend/replace flows, recovery, and cross-venue semantics, so one overview would hide multiple verification boundaries. |
| 5 | `055-per-trade-level-outage-protection/` | Per-Trade Level Outage Protection | [055-per-trade-level-outage-protection/001-plan.md](../055-per-trade-level-outage-protection/001-plan.md) | `001-overview.md` | not required | This is one bounded protection-gap feature once the accepted limitation and chosen path are fixed. |
| 6 | `057-watch-cleanup-on-position-close/` | Watch Cleanup on Position Close | [057-watch-cleanup-on-position-close/001-plan.md](../057-watch-cleanup-on-position-close/001-plan.md) | `001-overview.md` | not required | This is a single cleanup feature with one implementation slice. |
| 7 | `004-tiered-capability-limits/` | Tiered Capability, Sandbox, and Tool Argument Limits | [001-plan-tiered-capability-limits/001-plan.md](../001-plan-tiered-capability-limits/001-plan.md) | `001-roadmap.md` | required | The current plan already spans operator config, plan entitlements, sandbox enforcement, and argument-limit enforcement as separate verifiable slices. |
| 8 | `005-unified-skill-discoverability/` | Unified Skill Discoverability | [2026/08/29/001-unified-skill-discoverability/001-plan.md](../../2026/08/29/001-unified-skill-discoverability/001-plan.md) | `001-overview.md` | not required | The current source is an implementation-ready single feature plan, not a feature-internal roadmap. |
| 9 | `002-blank-slate-agents/` | Blank-Slate Agents | [002-blank-slate-agents/001-plan.md](../002-blank-slate-agents/001-plan.md) | `001-overview.md` | not required | One canonical overview can bound the one-click creation flow, guidance UX, and self-management tools. |
| 10 | `003-agent-chat-sessions/` | Agent Chat Sessions | [003-agent-chat-sessions/000-notes.md](../003-agent-chat-sessions/000-notes.md) | `001-roadmap.md` | required | The feature crosses data model, runtime model, creation flow, and hidden-agent lifecycle boundaries, so it needs ordered child docs. |
| 11 | `007-llm-cost-attribution-metrics/` | LLM Cost Attribution Metrics | [007-llm-cost-attribution-metrics/001-plan.md](../007-llm-cost-attribution-metrics/001-plan.md) | `001-overview.md` | not required | This remains one bounded accounting and observability feature. |
| 12 | `070-agent-min-tick-interval-extension/` | Agent Minimum Tick Interval Extension | [070-agent-min-tick-interval-extension/001-plan.md](../070-agent-min-tick-interval-extension/001-plan.md) | `001-overview.md` | not required | The feature is a single runtime-control slice with one policy boundary. |
| 13 | `071-skill-driven-tick-interval-defaults/` | Skill-Driven Tick Interval Defaults | [071-skill-driven-tick-interval-defaults/001-plan.md](../071-skill-driven-tick-interval-defaults/001-plan.md) | `001-overview.md` | not required | The feature is a single derivation rule layered on the cadence model. |
| 14 | `025-agent-message-document-handling/` | Agent Message Document Handling | [025-agent-message-document-handling/000-notes.md](../025-agent-message-document-handling/000-notes.md) | `001-roadmap.md` | required | The current source already breaks the work into staged ingestion, multimodal runtime, and UI/polish slices. |
| 15 | `056-agent-outbound-message-attachments/` | Agent Outbound Message Attachments | [056-agent-outbound-message-attachments/001-plan.md](../056-agent-outbound-message-attachments/001-plan.md) | `001-overview.md` | not required | This is one outbound delivery feature layered on the stored-document model from feature 025. |
| 16 | `075-additional-trading-skills/` | Additional Trading Skills | [075-additional-trading-skills.md/000-notes.md](../075-additional-trading-skills.md/000-notes.md) | `001-overview.md` | not required | The current source is a scope-and-feasibility filter whose first normalized form should stay as one canonical overview plus tasks only if the feature becomes execution-ready. |
| 17 | `015-marketplace-pricing-for-skills-and-blueprints/` | Marketplace Pricing for Skills and Blueprints | [015-marketplace-pricing-for-skills-and-blueprints/001-plan.md](../015-marketplace-pricing-for-skills-and-blueprints/001-plan.md) | `001-roadmap.md` | required | The current plan already stages skills pricing before blueprint monetization. |
| 18 | `010-daily-brief/` | Daily Brief | [010-daily-brief/000-analysis.md](../010-daily-brief/000-analysis.md) | `001-roadmap.md` | required | The current source already separates quick-win, polish, and validation phases across API, public pages, and onboarding usage. |
| 19 | `080-i18n-expansion/` | i18n Expansion | [080-i18n-expansion/001-plan.md](../080-i18n-expansion/001-plan.md) | `001-roadmap.md` | required | The current plan already separates prerequisite resolution, channel coverage, locale expansion, and regression tooling. |
| 20 | `099-tests/` | Program Regression and Coverage Hardening | [099-tests/001-plan.md](../099-tests/001-plan.md) | `001-overview.md` | not required | This hardening feature should stay task-list driven instead of inventing middle-level docs for each regression case. |

## Independent Follow-Up Feature

This feature remains part of the pending feature inventory, but it is not on the
active staged path and must not pre-empt it.

| Canonical folder | Canonical title | Current source entrypoint | Canonical high-level doc | `002+` child docs | Notes |
| --- | --- | --- | --- | --- | --- |
| `027-openaidom-brand-rollout-follow-up/` | OpenAIdom Brand Rollout Follow-Up | [027-openaidom-brand-rollout-followup/001-plan.md](../027-openaidom-brand-rollout-followup/001-plan.md) | `001-overview.md` | not required | This is a real feature with a current task list, but it stays on the separate follow-up track from the master roadmap. |

## Backlog Notes Outside The Program

These entries are not active program features and must not be treated as
authoritative implementation entrypoints.

| Current source | Current role | Canonical pending folder if promoted later | Canonical title if promoted later | Active staged feature now? | Notes |
| --- | --- | --- | --- | --- | --- |
| [platform-preset-transition-followup/good-to-have.md](../platform-preset-transition-followup/good-to-have.md) | Unnumbered aspirational note | `028-platform-preset-transition-follow-up/` | Platform Preset Transition Follow-Up | no | Keep it out of the active roadmap until a later roadmap change promotes it into a real feature. |

## Normalization Consequences

The later normalization pass should apply these folder-name decisions:

1. normalize `001-plan-tiered-capability-limits/` into
   `004-tiered-capability-limits/`;
2. create `005-unified-skill-discoverability/` under
   `docs/features/pending/` and seed it from the dated source plan at
   `docs/features/2026/08/29/001-unified-skill-discoverability/001-plan.md`;
3. normalize `075-additional-trading-skills.md/` into
   `075-additional-trading-skills/`;
4. normalize `027-openaidom-brand-rollout-followup/` into
   `027-openaidom-brand-rollout-follow-up/` if the feature remains in pending
   after the follow-up track is reviewed;
5. keep `platform-preset-transition-followup/` outside the active staged path;
   only if it is promoted later should it take the reserved canonical folder
   `028-platform-preset-transition-follow-up/`.

## Validation

1. Compared the active staged feature list against the current top-level
   entries already present under `docs/features/pending/`.
2. Matched `001-roadmap.md` versus `001-overview.md` assignments against the
   rules in [000-document-tree.md](./000-document-tree.md) and
   [002-feature-doc-template.md](./002-feature-doc-template.md).
3. Aligned the active feature inventory with
   [001-master-roadmap.md](./001-master-roadmap.md) and corrected the roadmap
   where it omitted an active feature or linked to a missing pending path.
4. Applied the active-path versus follow-up versus backlog distinctions from
   [004-validation-and-change-control.md](./004-validation-and-change-control.md).