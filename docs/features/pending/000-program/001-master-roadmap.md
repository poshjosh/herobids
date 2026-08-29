# Pending Program Master Roadmap

**Status:** proposed  
**Created:** 2026-08-29

## Purpose

This roadmap fixes the execution order, dependency edges, and program-wide
invariants for the current pending feature set under
`docs/features/pending/`.

It is anchored to the canonical document tree in
[000-document-tree.md](./000-document-tree.md). This step does not rename
legacy feature folders or filenames. Normalization remains later program work.

## Execution Model

The phase order below is strict.

Inside a phase, the listed order is the default planning and handoff order.
Parallel execution is acceptable only after the dependency column for a feature
is already satisfied.

The only exception is a phase explicitly marked as an independent follow-up
track. Those items stay lower-priority than the main execution path and should
not pre-empt it, but they do not introduce dependency edges back into the main
program.

When a feature has not yet been normalized to `001-overview.md` or
`001-roadmap.md`, this roadmap links to the current highest-authority legacy
doc as a provisional entrypoint. Later program steps normalize those entry
surfaces.

Dependency notation uses stable feature slugs rather than numeric prefixes,
because the current pending tree already contains multiple `000-*` folders.
Each dependency name below refers to the matching feature folder slug unless a
row explicitly names an external prerequisite that lives outside the current
pending feature tree.

## Execution Phases

### Phase 1: Capability Platform Foundation

| Order | Feature | Depends on | Role in the program |
| --- | --- | --- | --- |
| 1 | [000-capability-foundations](../000-capability-foundations/001-roadmap.md) | none | Critical path for capability isolation, registry, ownership, activation, and extraction of trading and messaging into capability-owned service boundaries. |

### Phase 2: Trading Runtime Stabilization

| Order | Feature | Depends on | Role in the program |
| --- | --- | --- | --- |
| 2 | [001-hyperliquid-perp-preset-tuning](../001-hyperliquid-perp-preset-tuning/001-plan.md) | capability-foundations | Tighten segment-aware Hyperliquid scanner presets so later publishing and automation work sits on better market-selection defaults. |
| 3 | [030-exit-policy-scale-out-trail](../030-exit-policy-scale-out-trail/001-plan.md) | capability-foundations, hyperliquid-perp-preset-tuning | Add partial exits and trailing-stop behavior on top of the stabilized capability and preset surface. |
| 4 | [040-advanced-live-limit-order-management](../040-advanced-live-limit-order-management/001-plan.md) | exit-policy-scale-out-trail | Extend the minimal live-order path to full amend, replace, recovery, and reconciliation semantics. |
| 5 | [055-per-trade-level-outage-protection](../055-per-trade-level-outage-protection/001-plan.md) | advanced-live-limit-order-management | Record and bound the current protection model without pretending venue-native trigger protection already exists. |
| 6 | [057-watch-cleanup-on-position-close](../057-watch-cleanup-on-position-close/001-plan.md) | exit-policy-scale-out-trail, advanced-live-limit-order-management | Remove stale watches and memory after close so later cadence and messaging features do not build on dirty position state. |

### Phase 3: Agent Runtime And Control Surfaces

| Order | Feature | Depends on | Role in the program |
| --- | --- | --- | --- |
| 7 | [000-unified-skill-discoverability](../000-unified-skill-discoverability/001-plan.md) | capability-foundations | Make platform and external skill discovery part of the default agent skill surface before more self-managing agent experiences are layered on top. |
| 8 | [002-blank-slate-agents](../002-blank-slate-agents/001-plan.md) | capability-foundations, unified-skill-discoverability | Add one-click blank-slate agent creation and self-management of prompt and skills on top of the capability-owned runtime. |
| 9 | [003-agent-chat-sessions](../003-agent-chat-sessions/000-notes.md) | blank-slate-agents | Establish session-centric chat architecture and keep chat semantics separate from tick-driven runtime semantics. |
| 10 | [007-llm-cost-attribution-metrics](../007-llm-cost-attribution-metrics/001-plan.md) | capability-foundations, agent-chat-sessions | Measure LLM spend by execution path and trigger source before expanding recurring, monetized, or document-heavy agent flows. |
| 11 | [070-agent-min-tick-interval-extension](../070-agent-min-tick-interval-extension/001-plan.md) | agent-chat-sessions | Add bounded agent-requested tick extensions without weakening operator or user controls. |
| 12 | [071-skill-driven-tick-interval-defaults](../071-skill-driven-tick-interval-defaults/001-plan.md) | agent-chat-sessions, agent-min-tick-interval-extension | Derive default cadence from selected skills only after the bounded extension model exists. |

### Phase 4: Documents And Messaging

| Order | Feature | Depends on | Role in the program |
| --- | --- | --- | --- |
| 13 | [025-agent-message-document-handling](../025-agent-message-document-handling/000-notes.md) | agent-chat-sessions, llm-cost-attribution-metrics | Add inbound multimodal and document support on the session-centric chat surface with cost attribution already in place. |
| 14 | [056-agent-outbound-message-attachments](../056-agent-outbound-message-attachments/001-plan.md) | agent-message-document-handling | Add outbound email and Telegram attachments backed by the stored-document model rather than a separate capability track. |

### Phase 5: Skills, Publishing, And Commercialization

| Order | Feature | Depends on | Role in the program |
| --- | --- | --- | --- |
| 15 | [075-additional-trading-skills](../075-additional-trading-skills.md/000-notes.md) | capability-foundations, unified-skill-discoverability | Publish additional methodology skills once the capability foundation is stable, while acknowledging the current candle and OHLCV tool gap. |
| 16 | [015-marketplace-pricing-for-skills-and-blueprints](../015-marketplace-pricing-for-skills-and-blueprints/001-plan.md) | blank-slate-agents, llm-cost-attribution-metrics, unified-skill-discoverability | Finish skill pricing and checkout, then extend the same commerce path to blueprints after the runtime model and cost accounting are stable. |
| 17 | [010-daily-brief](../010-daily-brief/000-analysis.md) | hyperliquid-perp-preset-tuning, llm-cost-attribution-metrics, additional-trading-skills | Publish recurring market-intelligence digests only after preset quality, execution-path metering, and enough recommendation logic exist to make the brief credible. |

### Phase 6: Localization And Program Hardening

| Order | Feature | Depends on | Role in the program |
| --- | --- | --- | --- |
| 18 | [080-i18n-expansion](../080-i18n-expansion/001-plan.md) | agent-chat-sessions, agent-message-document-handling, agent-outbound-message-attachments, external web i18n prerequisite | Localize Telegram, email, and server messaging only after the chat and document flows are stable and the missing web prerequisite is explicitly resolved. |
| 19 | [099-tests](../099-tests/001-plan.md) | capability-foundations, hyperliquid-perp-preset-tuning, exit-policy-scale-out-trail, advanced-live-limit-order-management, per-trade-level-outage-protection, watch-cleanup-on-position-close, unified-skill-discoverability, blank-slate-agents, agent-chat-sessions, llm-cost-attribution-metrics, agent-min-tick-interval-extension, skill-driven-tick-interval-defaults, agent-message-document-handling, agent-outbound-message-attachments, additional-trading-skills, marketplace-pricing-for-skills-and-blueprints, daily-brief, i18n-expansion | Expand coverage around the accepted boundaries and known failures after the feature surfaces above stop moving. |

### Phase 7: Independent Follow-Up Work

| Order | Feature | Depends on | Role in the program |
| --- | --- | --- | --- |
| 20 | [027-openaidom-brand-rollout-followup](../027-openaidom-brand-rollout-followup/001-plan.md) | none | Close the remaining Tier 2 brand rollout gaps after the main program path, while keeping the work isolated from capability, trading, and chat sequencing. |

## Fixed Now

These points are fixed now by the roadmap, even where product implementation is
still pending.

1. [000-capability-foundations](../000-capability-foundations/001-roadmap.md)
   is the mandatory first executable feature and gates all later capability,
   ownership, activation, and service-boundary work.
2. Trading runtime work follows an incremental ladder: preset quality first,
   then exit behavior, then advanced order management, then outage-boundary
   clarification, then watch cleanup.
3. [003-agent-chat-sessions](../003-agent-chat-sessions/000-notes.md) owns the
   chat model. Later cadence, document, and attachment features must layer on a
   session-centric architecture rather than reusing tick-loop semantics.
4. [000-unified-skill-discoverability](../000-unified-skill-discoverability/001-plan.md)
   is part of the active agent runtime surface and must be treated as a real
   program feature, not an out-of-band parent-plan fragment.
5. [007-llm-cost-attribution-metrics](../007-llm-cost-attribution-metrics/001-plan.md)
   is the accounting baseline for later publishing, pricing, and
   document-processing features.
6. [025-agent-message-document-handling](../025-agent-message-document-handling/000-notes.md)
   and [056-agent-outbound-message-attachments](../056-agent-outbound-message-attachments/001-plan.md)
   are one document-handling track. Attachments are not a separate top-level
   capability.
7. [055-per-trade-level-outage-protection](../055-per-trade-level-outage-protection/001-plan.md)
   remains a limitation-defining feature in this program. Venue-native trigger
   protection stays future work unless a separate feature is created.
8. [080-i18n-expansion](../080-i18n-expansion/001-plan.md) does not invent or
   absorb the missing web i18n prerequisite. That prerequisite must be handled
   separately before 080 becomes execution-ready.
9. [099-tests](../099-tests/001-plan.md) is a hardening feature, not a license
   to reopen accepted feature boundaries.

## Global Invariants

1. The active program-control surface starts at
   [000-document-tree.md](./000-document-tree.md) and this roadmap.
2. This roadmap is folder-centric by design because many pending features still
   use legacy file naming. C02 records order and dependencies; it does not
   normalize legacy filenames.
3. Capability isolation, ownership, activation, and cross-service boundaries
   must be settled before user-facing agent creation, commerce, or document
   expansion proceeds.
4. Chat architecture, tick cadence, and document handling are related but not
   interchangeable concerns; later features must preserve those boundaries.
5. Cost attribution must stay compatible across trigger source, execution path,
   and future monetized surfaces.
6. Live-trading protection work must not claim capabilities that the venue or
   the engine does not yet implement safely.

## Open Or Deferred

1. Normalize legacy filenames and irregular folder names in later program tasks;
   do not rename anything in C02.
2. Split features into canonical `001-overview.md`, `001-roadmap.md`, and
   `tasks/` shapes only when the later inventory and feature-template work has
   fixed those authoring rules.
3. Unblock [075-additional-trading-skills](../075-additional-trading-skills.md/000-notes.md)
   by adding the missing candle and OHLCV tool support or by explicitly
   narrowing the feature around that gap.
4. Define the external web i18n prerequisite before
   [080-i18n-expansion](../080-i18n-expansion/001-plan.md) can move from plan to
   implementation.
5. Keep [027-openaidom-brand-rollout-followup](../027-openaidom-brand-rollout-followup/001-plan.md)
   on an explicitly independent follow-up track rather than forcing it into the
   platform-critical phases.
6. Treat [platform-preset-transition-followup](../platform-preset-transition-followup/good-to-have.md)
   as an aspirational backlog note, not an active program feature, until it is
   converted into a numbered normalized feature or archived.
7. Revisit venue-native outage-trigger protection only through a dedicated later
   feature rather than widening
   [055-per-trade-level-outage-protection](../055-per-trade-level-outage-protection/001-plan.md)
   during this program.

## Irregular Items And Interim Treatment

| Item | Current state | Interim treatment |
| --- | --- | --- |
| [075-additional-trading-skills.md](../075-additional-trading-skills.md/000-notes.md) | Active feature with an irregular folder name | Keep it in execution order, but defer naming normalization to later program-control work. |
| [027-openaidom-brand-rollout-followup](../027-openaidom-brand-rollout-followup/001-plan.md) | Ready implementation plan for independent brand-hardening work | Keep it ordered on a non-critical follow-up track and avoid mixing it into capability-platform sequencing. |
| [platform-preset-transition-followup](../platform-preset-transition-followup/good-to-have.md) | Unnumbered, aspirational note | Keep it out of the active execution path until it is normalized into a real feature or archived. |

## What This Roadmap Leaves For Later

This roadmap fixes program order and boundaries. It intentionally leaves the
following work for later documents:

1. the canonical feature inventory and normalization pass;
2. per-feature high-level docs where only legacy notes currently exist;
3. any deeper phase split for large features beyond
   [000-capability-foundations](../000-capability-foundations/001-roadmap.md);
4. implementation task lists outside the first executable slices.