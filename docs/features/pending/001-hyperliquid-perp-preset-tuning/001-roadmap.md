# Asset-Class-Aware Hyperliquid Perp Preset Tuning

**Status:** draft  
**Created:** 2026-08-29  
**Parent roadmap:** [Pending Program Master Roadmap](../000-program/001-master-roadmap.md)

## Purpose

Decompose Hyperliquid perp preset tuning into ordered slices so calibration,
schema changes, runtime resolution, and preset retuning can be executed without
mixing evidence gathering with production threshold changes.

## Scope

This roadmap includes:

1. Hyperliquid perp market segmentation derived from measurable scanner inputs.
2. Segment-aware preset schema and config-resolution changes.
3. Shared runtime resolution for live scans and preset assessment.
4. Evidence-backed retuning of Hyperliquid scanner presets.

This roadmap does not include:

1. Swap-venue tuning or a generic cross-venue asset taxonomy.
2. Fully automated parameter optimization.
3. Unrelated strategy-catalog changes beyond segment-aware threshold tuning.
4. Product-code implementation in this documentation step.

## Non-Goals

1. Do not generalize the first segmentation model beyond Hyperliquid perps.
2. Do not hard-code venue branching into generic indicator math.
3. Do not retune presets from intuition alone without calibration evidence.
4. Do not allow preset assessment and live scanning to diverge on effective
   config resolution.

## Dependencies

1. [Pending Program Master Roadmap](../000-program/001-master-roadmap.md)
   fixes this feature after capability foundations and before later trading
   runtime features.
2. [Pending Feature Inventory](../000-program/005-feature-inventory.md)
   requires this feature to use a canonical `001-roadmap.md` with ordered child
   docs.
3. [001-plan.md](./001-plan.md) remains the legacy source material for the
   calibration model, schema direction, runtime invariants, and rollout order
   until C09 creates the executable child docs.
4. This feature depends on capability foundations at program level, but its own
   internal sequencing is calibration first, then schema and runtime work, then
   retuning and validation.

## Fixed Decisions

1. The first implementation is limited to Hyperliquid perp scanning.
2. Market segments are based on measurable trading behavior, not token labels.
3. Baseline preset params remain the fallback; segment overrides are partial and
   additive.
4. Effective segment-aware config is resolved before generic candidate scoring.
5. Live technical scans and preset assessment must use the same shared segment
   classification and config-resolution path.

## Open Latitude

Implementation may choose the following without escalation, as long as the
fixed decisions, dependencies, acceptance criteria, and validation still hold:

1. the exact classifier thresholds and statistical cut points justified by the
   calibration evidence
2. the specific helper/module boundaries for calibration, classification, and
   deep-merge resolution
3. the exact pilot strategy order for initial retuning, as long as validation
   remains evidence-driven

## Child Docs And Sequence

Executable child docs to create in C09:

1. `002-calibration-and-segmentation.md`
2. `003-segment-aware-preset-schema.md`
3. `004-runtime-segment-resolution.md`
4. `005-hyperliquid-preset-retuning.md`
5. `006-validation-and-evidence.md`

Supporting implementation tasks should be created only after those child docs
make the first executable slice explicit.

## Acceptance Criteria

1. The feature-wide scope, dependencies, and sequencing match the master
   roadmap and the feature inventory.
2. The child-doc sequence covers the source plan's full path from calibration
   through schema, runtime resolution, retuning, and validation.
3. The roadmap fixes the cross-slice invariants that later child docs must not
   reopen, especially Hyperliquid-only scope and shared config resolution.
4. Later C09 and C10 work can create executable child docs and task lists
   without guessing the intended order.

## Validation

1. Compared this roadmap against the phases and rollout guidance in
   [001-plan.md](./001-plan.md).
2. Confirmed the dependency position and canonical doc shape against
   [../000-program/001-master-roadmap.md](../000-program/001-master-roadmap.md)
   and [../000-program/005-feature-inventory.md](../000-program/005-feature-inventory.md).
3. Verified that the required canonical section order matches
   [../000-program/002-feature-doc-template.md](../000-program/002-feature-doc-template.md).